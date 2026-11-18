const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { appendRotatingFile } = require('../infrastructure/file-rotation');
const {
    cleanupFiles,
    runRetentionCleanup
} = require('../infrastructure/retention-manager');

async function withTempDirectory(callback) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rs-ge-retention-'));
    try {
        return await callback(directory);
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
}

async function createFile(filePath, content, modifiedAt) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content);
    if (modifiedAt) await fs.promises.utimes(filePath, modifiedAt, modifiedAt);
}

test('rotates an operational log before a write exceeds its size limit', async () => {
    await withTempDirectory(async (directory) => {
        const logPath = path.join(directory, 'agent.log');
        const now = new Date('2026-11-18T12:00:00.000Z');
        appendRotatingFile(logPath, 'first\n', { maxBytes: 10, now });
        const rotatedPath = appendRotatingFile(logPath, 'second\n', { maxBytes: 10, now });

        assert.ok(rotatedPath);
        assert.equal(await fs.promises.readFile(rotatedPath, 'utf8'), 'first\n');
        assert.equal(await fs.promises.readFile(logPath, 'utf8'), 'second\n');
    });
});

test('rotates an operational log after the configured age', async () => {
    await withTempDirectory(async (directory) => {
        const logPath = path.join(directory, 'agent.log');
        const oldDate = new Date('2026-11-17T10:00:00.000Z');
        await createFile(logPath, 'old\n', oldDate);

        const rotatedPath = appendRotatingFile(logPath, 'new\n', {
            maxBytes: 1024,
            rotationIntervalMs: 24 * 60 * 60 * 1000,
            now: new Date('2026-11-18T12:00:00.000Z')
        });

        assert.ok(rotatedPath);
        assert.equal(await fs.promises.readFile(rotatedPath, 'utf8'), 'old\n');
        assert.equal(await fs.promises.readFile(logPath, 'utf8'), 'new\n');
    });
});

test('dry-run selects expired screenshots without deleting them', async () => {
    await withTempDirectory(async (directory) => {
        const now = new Date('2026-11-18T12:00:00.000Z');
        const oldFile = path.join(directory, 'old.png');
        await createFile(oldFile, 'old', new Date('2026-11-16T12:00:00.000Z'));

        const result = await cleanupFiles({
            rootDir: directory,
            maxAgeMs: 24 * 60 * 60 * 1000,
            now,
            dryRun: true
        });

        assert.equal(result.selectedFiles, 1);
        assert.equal(result.deletedFiles, 0);
        assert.equal(await fs.promises.readFile(oldFile, 'utf8'), 'old');
    });
});

test('enforces a directory quota by deleting the oldest files first', async () => {
    await withTempDirectory(async (directory) => {
        const oldest = path.join(directory, 'oldest.png');
        const newest = path.join(directory, 'newest.png');
        await createFile(oldest, 'a'.repeat(60), new Date('2026-11-17T10:00:00.000Z'));
        await createFile(newest, 'b'.repeat(50), new Date('2026-11-18T10:00:00.000Z'));

        const result = await cleanupFiles({
            rootDir: directory,
            maxTotalBytes: 80,
            now: new Date('2026-11-18T12:00:00.000Z')
        });

        assert.equal(result.quotaFiles, 1);
        assert.equal(result.deletedFiles, 1);
        await assert.rejects(fs.promises.access(oldest), { code: 'ENOENT' });
        assert.equal((await fs.promises.stat(newest)).size, 50);
    });
});

test('runtime cleanup preserves audit logs and explicit evidence', async () => {
    await withTempDirectory(async (directory) => {
        const logsDir = path.join(directory, 'logs');
        const screenshotsRootDir = path.join(directory, 'screenshots');
        const screenshotsDir = path.join(screenshotsRootDir, 'tmp');
        const evidenceDir = path.join(screenshotsRootDir, 'evidence');
        const oldDate = new Date('2026-11-16T12:00:00.000Z');
        const archive = path.join(logsDir, 'agent.log.2026-11-16');
        const audit = path.join(logsDir, 'audit.jsonl');
        const screenshot = path.join(screenshotsDir, 'login.png');
        const evidence = path.join(evidenceDir, 'submission-proof.png');
        await createFile(archive, 'archive', oldDate);
        await createFile(audit, 'audit', oldDate);
        await createFile(screenshot, 'screenshot', oldDate);
        await createFile(evidence, 'evidence', oldDate);

        const auditEvents = [];
        const result = await runRetentionCleanup({
            config: {
                rsGe: { screenshotsRootDir, screenshotsDir, evidenceDir },
                runtime: {
                    logsDir,
                    retention: {
                        logRetentionDays: 1,
                        logMaxTotalBytes: 1024,
                        screenshotTtlHours: 24,
                        screenshotMaxTotalBytes: 1024,
                        cleanupIntervalMinutes: 60
                    }
                }
            },
            now: new Date('2026-11-18T12:00:00.000Z'),
            auditLog: { record: async (event) => auditEvents.push(event) }
        });

        assert.equal(result.logs.deletedFiles, 1);
        assert.equal(result.screenshots.deletedFiles, 1);
        await assert.rejects(fs.promises.access(archive), { code: 'ENOENT' });
        await assert.rejects(fs.promises.access(screenshot), { code: 'ENOENT' });
        assert.equal(await fs.promises.readFile(audit, 'utf8'), 'audit');
        assert.equal(await fs.promises.readFile(evidence, 'utf8'), 'evidence');
        assert.equal(auditEvents.length, 1);
        assert.equal(auditEvents[0].action, 'runtime.retention.cleanup');
        assert.equal(auditEvents[0].metadata.bytesDeleted, 17);
    });
});

test('retention dry-run does not create missing runtime directories', async () => {
    await withTempDirectory(async (directory) => {
        const logsDir = path.join(directory, 'missing-logs');
        const screenshotsRootDir = path.join(directory, 'missing-screenshots');
        const screenshotsDir = path.join(screenshotsRootDir, 'tmp');
        const evidenceDir = path.join(screenshotsRootDir, 'evidence');

        await runRetentionCleanup({
            dryRun: true,
            config: {
                rsGe: { screenshotsRootDir, screenshotsDir, evidenceDir },
                runtime: {
                    logsDir,
                    retention: {
                        logRetentionDays: 14,
                        logMaxTotalBytes: 1024,
                        screenshotTtlHours: 24,
                        screenshotMaxTotalBytes: 1024,
                        cleanupIntervalMinutes: 60
                    }
                }
            },
            auditLog: { record: async () => assert.fail('dry-run must not write audit events') }
        });

        await assert.rejects(fs.promises.access(logsDir), { code: 'ENOENT' });
        await assert.rejects(fs.promises.access(screenshotsRootDir), { code: 'ENOENT' });
    });
});
