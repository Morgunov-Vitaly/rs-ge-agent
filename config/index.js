const path = require('path');
require('dotenv').config();

function parseChatId(value) {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(?:1|true|yes|on)$/i.test(String(value).trim());
}

function megabytes(value, fallback) {
    return Math.round(parsePositiveNumber(value, fallback) * 1024 * 1024);
}

function loadConfig(env = process.env) {
    const screenshotsRootDir = path.resolve(env.RS_SCREENSHOTS_DIR || './screenshots');
    const logsDir = path.resolve(env.LOGS_DIR || './logs');

    return Object.freeze({
        telegram: Object.freeze({
            token: env.TELEGRAM_BOT_TOKEN || '',
            allowedChatId: parseChatId(env.TELEGRAM_CHAT_ID)
        }),
        rsGe: Object.freeze({
            username: env.RS_USERNAME || '',
            password: env.RS_PASSWORD || '',
            sessionStoragePath: path.resolve(env.RS_SESSION_STORAGE_PATH || './session_state.json'),
            screenshotsRootDir,
            screenshotsDir: path.resolve(env.RS_SCREENSHOTS_TMP_DIR || path.join(screenshotsRootDir, 'tmp')),
            evidenceDir: path.resolve(env.RS_EVIDENCE_DIR || path.join(screenshotsRootDir, 'evidence')),
            chromiumExecutablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '',
            enableSubmission: parseBoolean(env.RSGE_ENABLE_SUBMISSION, false),
            evidenceEncryptionKey: env.RSGE_EVIDENCE_KEY || ''
        }),
        google: Object.freeze({
            spreadsheetId: env.GOOGLE_SPREADSHEET_ID || '',
            credentialsPath: path.resolve(env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json')
        }),
        runtime: Object.freeze({
            logsDir,
            auditLogPath: path.resolve(env.AUDIT_LOG_PATH || path.join(logsDir, 'audit.jsonl')),
            retention: Object.freeze({
                logMaxSizeBytes: megabytes(env.LOG_MAX_SIZE_MB, 10),
                logRotationHours: parsePositiveNumber(env.LOG_ROTATION_HOURS, 24),
                logRetentionDays: parsePositiveNumber(env.LOG_RETENTION_DAYS, 14),
                logMaxTotalBytes: megabytes(env.LOG_MAX_TOTAL_SIZE_MB, 100),
                screenshotTtlHours: parsePositiveNumber(env.SCREENSHOT_TTL_HOURS, 24),
                screenshotMaxTotalBytes: megabytes(env.SCREENSHOT_MAX_SIZE_MB, 250),
                cleanupIntervalMinutes: parsePositiveNumber(env.CLEANUP_INTERVAL_MINUTES, 60)
            })
        })
    });
}

function assertConfig(config, scopes) {
    const missing = [];
    const requested = new Set(scopes);

    if (requested.has('telegram') && !config.telegram.token) {
        missing.push('TELEGRAM_BOT_TOKEN');
    }
    if (requested.has('rsge')) {
        if (!config.rsGe.username) missing.push('RS_USERNAME');
        if (!config.rsGe.password) missing.push('RS_PASSWORD');
    }
    if (requested.has('google')) {
        if (!config.google.spreadsheetId) missing.push('GOOGLE_SPREADSHEET_ID');
        if (!config.google.credentialsPath) missing.push('GOOGLE_CREDENTIALS_PATH');
    }
    if (
        requested.has('submission') &&
        config.rsGe.enableSubmission &&
        !config.rsGe.evidenceEncryptionKey
    ) {
        missing.push('RSGE_EVIDENCE_KEY');
    }

    if (missing.length) {
        throw new Error(`Не заданы обязательные параметры конфигурации: ${missing.join(', ')}`);
    }

    return config;
}

const config = loadConfig();

module.exports = {
    config,
    loadConfig,
    assertConfig,
    parseBoolean
};
