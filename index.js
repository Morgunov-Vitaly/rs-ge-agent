/** Запуск выбранных интерфейсов, хранилища, резервного копирования и очистки runtime-файлов. */

require('dotenv').config();
const logger = require('./services/logger');
const sheets = require('./services/sheets');
const { createIncomeRepository } = require('./connectors/income-repository');
const { createDailySqliteBackup } = require('./infrastructure/sqlite-backup');
const {
    runRetentionCleanup,
    scheduleRetentionCleanup
} = require('./infrastructure/retention-manager');
const { config, assertConfig } = require('./config');
const { startWebServer } = require('./web/server');

let retentionTimer;
let webRuntime;
let bot;
let sqliteBackupTimer;

function formatCleanupResult(result) {
    return {
        logsDeleted: result.logs.deletedFiles,
        screenshotsDeleted: result.screenshots.deletedFiles,
        bytesDeleted: result.logs.deletedBytes + result.screenshots.deletedBytes
    };
}

async function main() {
    assertConfig(config, ['storage']);
    if (config.telegram.enabled) assertConfig(config, ['telegram']);
    if (config.web.enabled) assertConfig(config, ['web']);
    if (!config.telegram.enabled && !config.web.enabled) {
        throw new Error('Включите TELEGRAM_ENABLED или WEB_ENABLED');
    }
    logger.info('=== Запуск RS.GE Tax Agent ===');

    try {
        const cleanupResult = await runRetentionCleanup();
        logger.info('Проверка retention-политики завершена.', formatCleanupResult(cleanupResult));
    } catch (error) {
        logger.error('Не удалось выполнить стартовую очистку runtime-файлов:', error);
    }

    retentionTimer = scheduleRetentionCleanup({
        onResult: (result) => {
            const summary = formatCleanupResult(result);
            if (summary.logsDeleted || summary.screenshotsDeleted) {
                logger.info('Плановая очистка runtime-файлов завершена.', summary);
            }
        },
        onError: (error) => logger.error('Ошибка плановой очистки runtime-файлов:', error)
    });

    if (config.storage.driver === 'sheets') {
        try {
            logger.info('Подключение к Google Таблице...');
            await sheets.initSheetHeaders();
            logger.info('✓ Google Таблица успешно инициализирована.');
        } catch (err) {
            logger.error('Предупреждение по Google Таблице:', err.message);
        }
    } else {
        createIncomeRepository({ appConfig: config }).close();
        logger.info('✓ Локальная SQLite база готова.');
        try {
            const backup = await createDailySqliteBackup({ filePath: config.storage.sqlitePath });
            if (backup.created) logger.info('✓ Создана проверенная копия локальной базы.');
        } catch (error) {
            logger.error('Не удалось создать резервную копию SQLite:', error);
            throw error;
        }
        sqliteBackupTimer = setInterval(() => {
            createDailySqliteBackup({ filePath: config.storage.sqlitePath })
                .then((backup) => {
                    if (backup.created) logger.info('✓ Создана ежедневная копия локальной базы.');
                })
                .catch((error) => logger.error('Ошибка ежедневной копии SQLite:', error));
        }, 60 * 60 * 1000);
    }

    if (config.telegram.enabled) {
        ({ bot } = require('./services/bot'));
        logger.info('Запуск Telegram-бота...');
        bot.launch()
            .then(() => logger.info('✓ Telegram-бот успешно запущен и слушает команды!'))
            .catch((err) => logger.error('Ошибка запуска бота:', err));
    }

    if (config.web.enabled) {
        webRuntime = await startWebServer({ appConfig: config });
        logger.info(`✓ Web-интерфейс запущен на ${config.web.host}:${config.web.port}`);
    } else {
        logger.info('Web-интерфейс выключен (WEB_ENABLED=false).');
    }

    const stop = async (signal) => {
        logger.info(`Остановка (${signal})...`);
        if (retentionTimer) clearInterval(retentionTimer);
        if (sqliteBackupTimer) clearInterval(sqliteBackupTimer);
        if (bot) bot.stop(signal);
        if (webRuntime) {
            await webRuntime.close().catch((error) => {
                logger.warn('Не удалось штатно остановить Web-интерфейс:', error.message);
            });
        }
        process.exit(0);
    };

    process.once('SIGINT', () => void stop('SIGINT'));
    process.once('SIGTERM', () => void stop('SIGTERM'));
}

main();
