/**
 * index.js — Главная точка входа RS.GE Tax Agent
 * Запускает Telegram-бота с полным функционалом:
 * - Ввод доходов и автоконвертация NBG
 * - Ведение Google Таблицы
 * - Авторизация на rs.ge с вводом SMS в Telegram чате
 * - Read-only просмотр черновика и сверка данных RS.GE
 */

require('dotenv').config();
const logger = require('./services/logger');
const { bot } = require('./services/bot');
const sheets = require('./services/sheets');
const {
    runRetentionCleanup,
    scheduleRetentionCleanup
} = require('./infrastructure/retention-manager');

let retentionTimer;

function formatCleanupResult(result) {
    return {
        logsDeleted: result.logs.deletedFiles,
        screenshotsDeleted: result.screenshots.deletedFiles,
        bytesDeleted: result.logs.deletedBytes + result.screenshots.deletedBytes
    };
}

async function main() {
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

    // Проверяем доступность Google Sheets
    try {
        logger.info('Подключение к Google Таблице...');
        await sheets.initSheetHeaders();
        logger.info('✓ Google Таблица успешно инициализирована.');
    } catch (err) {
        logger.error('Предупреждение по Google Таблице:', err.message);
    }

    // Запускаем бота
    logger.info('Запуск Telegram-бота...');
    bot.launch()
        .then(() => {
            logger.info('✓ Telegram-бот успешно запущен и слушает команды!');
        })
        .catch((err) => {
            logger.error('Ошибка запуска бота:', err);
        });

    const stop = (signal) => {
        logger.info(`Остановка (${signal})...`);
        if (retentionTimer) clearInterval(retentionTimer);
        bot.stop(signal);
        process.exit(0);
    };

    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
}

main();
