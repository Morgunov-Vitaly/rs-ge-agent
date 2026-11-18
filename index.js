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

async function main() {
    logger.info('=== Запуск RS.GE Tax Agent ===');

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

    process.once('SIGINT', () => {
        logger.info('Остановка (SIGINT)...');
        bot.stop('SIGINT');
        process.exit(0);
    });

    process.once('SIGTERM', () => {
        logger.info('Остановка (SIGTERM)...');
        bot.stop('SIGTERM');
        process.exit(0);
    });
}

main();
