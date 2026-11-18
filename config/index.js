const path = require('path');
require('dotenv').config();

function parseChatId(value) {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function loadConfig(env = process.env) {
    return Object.freeze({
        telegram: Object.freeze({
            token: env.TELEGRAM_BOT_TOKEN || '',
            allowedChatId: parseChatId(env.TELEGRAM_CHAT_ID)
        }),
        rsGe: Object.freeze({
            username: env.RS_USERNAME || '',
            password: env.RS_PASSWORD || '',
            sessionStoragePath: path.resolve(env.RS_SESSION_STORAGE_PATH || './session_state.json'),
            screenshotsDir: path.resolve(env.RS_SCREENSHOTS_DIR || './screenshots'),
            chromiumExecutablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || ''
        }),
        google: Object.freeze({
            spreadsheetId: env.GOOGLE_SPREADSHEET_ID || '',
            credentialsPath: path.resolve(env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json')
        }),
        runtime: Object.freeze({
            auditLogPath: path.resolve(env.AUDIT_LOG_PATH || './logs/audit.jsonl')
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

    if (missing.length) {
        throw new Error(`Не заданы обязательные параметры конфигурации: ${missing.join(', ')}`);
    }

    return config;
}

const config = loadConfig();

module.exports = {
    config,
    loadConfig,
    assertConfig
};
