const fs = require('fs');
const path = require('path');
const { config: defaultConfig } = require('../config');
const { auditLog: defaultAuditLog } = require('./audit-log');
const { ACTION_RISKS } = require('../core/action-contract');

function isInside(candidate, parent) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function collectRegularFiles(rootDir, excludedDirectories = []) {
    const root = path.resolve(rootDir);
    const excluded = excludedDirectories.map((directory) => path.resolve(directory));
    const files = [];

    async function visit(candidate) {
        if (excluded.some((directory) => isInside(candidate, directory))) return;

        let stats;
        try {
            stats = await fs.promises.lstat(candidate);
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }

        if (stats.isSymbolicLink()) return;
        if (stats.isFile()) {
            files.push({ filePath: candidate, size: stats.size, mtimeMs: stats.mtimeMs });
            return;
        }
        if (!stats.isDirectory()) return;

        const entries = await fs.promises.readdir(candidate);
        await Promise.all(entries.map((entry) => visit(path.join(candidate, entry))));
    }

    await visit(root);
    return files;
}

async function cleanupFiles(options) {
    const nowMs = options.now instanceof Date ? options.now.getTime() : (options.now || Date.now());
    const maxAgeMs = options.maxAgeMs ?? Number.POSITIVE_INFINITY;
    const maxTotalBytes = options.maxTotalBytes ?? Number.POSITIVE_INFINITY;
    const include = options.include || (() => true);
    const dryRun = Boolean(options.dryRun);

    const files = (await collectRegularFiles(
        options.rootDir,
        options.excludedDirectories || []
    )).filter((file) => include(file.filePath));
    const oldestFirst = [...files].sort((left, right) => left.mtimeMs - right.mtimeMs);
    const selected = [];
    const selectedPaths = new Set();

    for (const file of oldestFirst) {
        if (nowMs - file.mtimeMs >= maxAgeMs) {
            selected.push({ ...file, reason: 'expired' });
            selectedPaths.add(file.filePath);
        }
    }

    let remainingBytes = files.reduce((sum, file) => sum + file.size, 0) -
        selected.reduce((sum, file) => sum + file.size, 0);
    for (const file of oldestFirst) {
        if (remainingBytes <= maxTotalBytes) break;
        if (selectedPaths.has(file.filePath)) continue;
        selected.push({ ...file, reason: 'quota' });
        selectedPaths.add(file.filePath);
        remainingBytes -= file.size;
    }

    let deletedFiles = 0;
    let deletedBytes = 0;
    const errors = [];
    if (!dryRun) {
        for (const file of selected) {
            try {
                await fs.promises.unlink(file.filePath);
                deletedFiles += 1;
                deletedBytes += file.size;
            } catch (error) {
                if (error.code !== 'ENOENT') errors.push(error.code || 'UNKNOWN_ERROR');
            }
        }
    }

    return {
        dryRun,
        scannedFiles: files.length,
        selectedFiles: selected.length,
        selectedBytes: selected.reduce((sum, file) => sum + file.size, 0),
        expiredFiles: selected.filter(({ reason }) => reason === 'expired').length,
        quotaFiles: selected.filter(({ reason }) => reason === 'quota').length,
        deletedFiles,
        deletedBytes,
        errors
    };
}

function isOperationalLogArchive(filePath) {
    return /^(agent|error)\.log\./.test(path.basename(filePath));
}

async function runRetentionCleanup(options = {}) {
    const appConfig = options.config || defaultConfig;
    const retention = appConfig.runtime.retention;
    const dryRun = Boolean(options.dryRun);
    const now = options.now || new Date();
    const auditLog = options.auditLog || defaultAuditLog;

    if (!dryRun) {
        await Promise.all([
            fs.promises.mkdir(appConfig.runtime.logsDir, { recursive: true }),
            fs.promises.mkdir(appConfig.rsGe.screenshotsDir, { recursive: true }),
            fs.promises.mkdir(appConfig.rsGe.evidenceDir, { recursive: true })
        ]);
    }

    const logs = await cleanupFiles({
        rootDir: appConfig.runtime.logsDir,
        include: isOperationalLogArchive,
        maxAgeMs: retention.logRetentionDays * 24 * 60 * 60 * 1000,
        maxTotalBytes: retention.logMaxTotalBytes,
        now,
        dryRun
    });
    const screenshots = await cleanupFiles({
        rootDir: appConfig.rsGe.screenshotsRootDir,
        excludedDirectories: [appConfig.rsGe.evidenceDir],
        maxAgeMs: retention.screenshotTtlHours * 60 * 60 * 1000,
        maxTotalBytes: retention.screenshotMaxTotalBytes,
        now,
        dryRun
    });

    const totalDeletedFiles = logs.deletedFiles + screenshots.deletedFiles;
    const totalErrors = logs.errors.length + screenshots.errors.length;
    if (!dryRun && (totalDeletedFiles > 0 || totalErrors > 0)) {
        await auditLog.record({
            action: 'runtime.retention.cleanup',
            risk: ACTION_RISKS.IRREVERSIBLE,
            status: totalErrors > 0 ? 'completed_with_errors' : 'completed',
            metadata: {
                policyDriven: true,
                logsDeleted: logs.deletedFiles,
                screenshotsDeleted: screenshots.deletedFiles,
                bytesDeleted: logs.deletedBytes + screenshots.deletedBytes,
                errors: totalErrors
            }
        });
    }

    return { dryRun, logs, screenshots };
}

function scheduleRetentionCleanup(options = {}) {
    const appConfig = options.config || defaultConfig;
    const intervalMs = appConfig.runtime.retention.cleanupIntervalMinutes * 60 * 1000;
    let running = false;
    const timer = setInterval(() => {
        if (running) return;
        running = true;
        runRetentionCleanup(options)
            .then((result) => options.onResult?.(result))
            .catch((error) => options.onError?.(error))
            .finally(() => {
                running = false;
            });
    }, intervalMs);
    timer.unref();
    return timer;
}

module.exports = {
    cleanupFiles,
    collectRegularFiles,
    isOperationalLogArchive,
    runRetentionCleanup,
    scheduleRetentionCleanup
};
