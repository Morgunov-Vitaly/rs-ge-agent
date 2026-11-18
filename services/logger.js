/**
 * services/logger.js
 * Модуль логирования: цветной вывод в консоль и сохранение в файлы logs/agent.log и logs/error.log.
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.resolve(__dirname, '../logs');

if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const APP_LOG_FILE = path.join(LOGS_DIR, 'agent.log');
const ERROR_LOG_FILE = path.join(LOGS_DIR, 'error.log');

function getTimestamp() {
    return new Date().toISOString();
}

function writeToFile(filePath, level, message, meta) {
    const time = getTimestamp();
    const metaStr = meta ? ` | ${typeof meta === 'object' ? JSON.stringify(meta) : meta}` : '';
    const line = `[${time}] [${level.toUpperCase()}] ${message}${metaStr}\n`;

    fs.appendFile(filePath, line, (err) => {
        if (err) console.error('Не удалось записать в лог-файл:', err.message);
    });
}

const logger = {
    info(message, meta) {
        console.log(`ℹ️ [${getTimestamp()}] ${message}`, meta || '');
        writeToFile(APP_LOG_FILE, 'info', message, meta);
    },

    warn(message, meta) {
        console.warn(`⚠️ [${getTimestamp()}] ${message}`, meta || '');
        writeToFile(APP_LOG_FILE, 'warn', message, meta);
    },

    error(message, errorOrMeta) {
        const errorDetails = errorOrMeta instanceof Error
            ? { message: errorOrMeta.message, stack: errorOrMeta.stack }
            : errorOrMeta;

        console.error(`❌ [${getTimestamp()}] ${message}`, errorDetails || '');
        writeToFile(APP_LOG_FILE, 'error', message, errorDetails);
        writeToFile(ERROR_LOG_FILE, 'error', message, errorDetails);
    },

    action(message, meta) {
        console.log(`🚀 [${getTimestamp()}] ${message}`, meta || '');
        writeToFile(APP_LOG_FILE, 'action', message, meta);
    }
};

module.exports = logger;
