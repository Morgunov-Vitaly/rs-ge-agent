/**
 * services/bot.js
 * Основной модуль Telegram-бота: интерфейс пользователя, команды,
 * пошаговый диалог добавления дохода, ввод SMS прямо в чат и запуск Playwright.
 */

const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const logger = require('./logger');
const nbg = require('./nbg');
const rules = require('./rules');
const sheets = require('./sheets');
const playwright = require('./playwright');
const { config, assertConfig } = require('../config');
const { createGoogleSheetsIncomeRepository } = require('../connectors/google-sheets/income-repository');
const { createRsGeBrowserClient } = require('../connectors/rsge/browser-client');
const { executePaymentReconciliation } = require('../workflows/payment-reconciliation');
const { executeDeclarationReview } = require('../workflows/declaration-review');

assertConfig(config, ['telegram']);
const BOT_TOKEN = config.telegram.token;
const ALLOWED_CHAT_ID = config.telegram.allowedChatId;
const recordsRepository = createGoogleSheetsIncomeRepository();

// Долгие браузерные операции запускаются в фоне, поэтому Telegram handler
// не должен ждать SMS-код и блокировать получение следующих update.
const bot = new Telegraf(BOT_TOKEN, {
    handlerTimeout: 60000
});

// Состояние сессий пользователей
const sessionState = {
    fillInProgress: false,
    fillChatId: null,
    activeOperation: null,
    waitingForSms: false,
    smsResolver: null,
    smsRejecter: null,
    smsChatId: null,
    smsTimeout: null,
    incomeWizard: {}
};

const SMS_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

function createFlowError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function clearSmsWaitState() {
    if (sessionState.smsTimeout) {
        clearTimeout(sessionState.smsTimeout);
    }
    sessionState.waitingForSms = false;
    sessionState.smsResolver = null;
    sessionState.smsRejecter = null;
    sessionState.smsChatId = null;
    sessionState.smsTimeout = null;
}

function resolveSmsCode(chatId, code) {
    if (!sessionState.waitingForSms || sessionState.smsChatId !== chatId || !sessionState.smsResolver) {
        return false;
    }

    const resolve = sessionState.smsResolver;
    clearSmsWaitState();
    resolve(code);
    return true;
}

function rejectSmsWait(chatId, error) {
    if (!sessionState.waitingForSms || sessionState.smsChatId !== chatId || !sessionState.smsRejecter) {
        return false;
    }

    const reject = sessionState.smsRejecter;
    clearSmsWaitState();
    reject(error);
    return true;
}

async function requestSmsCode(ctx, screenshotBuffer) {
    if (sessionState.waitingForSms) {
        throw createFlowError('Бот уже ожидает SMS-код для другой операции.', 'SMS_ALREADY_PENDING');
    }

    const smsPromise = new Promise((resolve, reject) => {
        sessionState.waitingForSms = true;
        sessionState.smsResolver = resolve;
        sessionState.smsRejecter = reject;
        sessionState.smsChatId = ctx.chat.id;
        sessionState.smsTimeout = setTimeout(() => {
            rejectSmsWait(
                ctx.chat.id,
                createFlowError('Время ожидания SMS-кода истекло. Запустите команду заново.', 'SMS_TIMEOUT')
            );
        }, SMS_WAIT_TIMEOUT_MS);
    });

    try {
        await ctx.replyWithPhoto({ source: screenshotBuffer }, {
            caption: '📲 На ваш телефон отправлен SMS-код от RS.GE!\n\nОтправьте код сюда одним сообщением. Ожидание — 5 минут.'
        });
    } catch (error) {
        rejectSmsWait(ctx.chat.id, error);
        throw error;
    }

    return smsPromise;
}

async function runFillFlow(ctx) {
    let result;

    try {
        const now = new Date();
        let reportYear = now.getFullYear();
        let reportMonth = now.getMonth();
        if (reportMonth < 1) {
            reportMonth = 12;
            reportYear -= 1;
        }

        const periodInfo = rules.checkSubmissionPeriod(reportYear, reportMonth, now);
        if (!periodInfo.canSubmit) {
            throw new Error(periodInfo.message);
        }

        result = await playwright.loginToRsGe((screenshotBuffer) => requestSmsCode(ctx, screenshotBuffer));

        await ctx.reply('🎉 Успешный вход в личный кабинет rs.ge!');

        const review = await executeDeclarationReview({
            recordsRepository,
            rsGeClient: createRsGeBrowserClient(result.page),
            year: reportYear,
            month: reportMonth
        });
        const { summary, yearSummary, draft, comparison: draftComparison } = review;

        if (!review.exists) {
            await ctx.reply(
                `ℹ️ Сохраненный черновик за ${String(reportMonth).padStart(2, '0')}.${reportYear} не найден. ` +
                'Автоматическое создание нового черновика будет добавлено следующим шагом.'
            );
            return;
        }

        const comparison = draftComparison.valuesMatch
            ? '✅ Данные совпадают с Google Sheets.'
            : '⚠️ Данные черновика отличаются от Google Sheets. Не отправляйте декларацию до проверки.';
        const statusComparison = draftComparison.statusMismatch
            ? '⚠️ В таблице указано «подана», но на RS.GE найдена сохраненная, не отправленная декларация.'
            : '';
        const paymentInfo = summary.isPaid
            ? `Оплата по таблице: ${summary.paymentDate}`
            : 'Оплата по таблице не отмечена';

        const caption =
            `Черновик за ${String(reportMonth).padStart(2, '0')}.${reportYear}\n` +
            `Статус RS.GE: ${draft.status || 'сохранен'}\n` +
            `Статус таблицы: ${summary.status}\n` +
            `${paymentInfo}\n` +
            `Графа 15: ${draft.fields[15].toFixed(2)} GEL\n` +
            `Графа 20: ${draft.fields[20].toFixed(2)} GEL\n` +
            `Графа 26: ${draft.fields[26].toFixed(2)} GEL\n` +
            `${comparison}\n` +
            `${statusComparison ? `${statusComparison}\n` : ''}` +
            `\nФорма открыта только для просмотра и не отправлена.`;

        await ctx.replyWithPhoto(
            { source: draft.screenshotBuffer },
            { caption }
        );
    } catch (err) {
        logger.error('Ошибка при запуске /fill:', err);

        if (err.code !== 'USER_CANCELLED') {
            await ctx.reply(`❌ Ошибка при авторизации: ${err.message}`);
            const errPath = path.resolve('./screenshots/error_step.png');
            if (fs.existsSync(errPath)) {
                await ctx.replyWithPhoto({ source: errPath });
            }
        }
    } finally {
        if (sessionState.smsChatId === ctx.chat.id) {
            clearSmsWaitState();
        }
        if (result && result.browser) {
            await result.browser.close().catch((err) => {
                logger.warn('Не удалось закрыть браузер:', err.message);
            });
        }
        sessionState.fillInProgress = false;
        sessionState.fillChatId = null;
        sessionState.activeOperation = null;
    }
}

async function replyLongText(ctx, text) {
    const maxLength = 3900;
    const lines = text.split('\n');
    let chunk = '';

    for (const line of lines) {
        const next = chunk ? `${chunk}\n${line}` : line;
        if (next.length > maxLength && chunk) {
            await ctx.reply(chunk);
            chunk = line;
        } else {
            chunk = next;
        }
    }

    if (chunk) await ctx.reply(chunk);
}

async function runPaymentsFlow(ctx) {
    let result;

    try {
        result = await playwright.loginToRsGe((screenshotBuffer) => requestSmsCode(ctx, screenshotBuffer));

        await ctx.reply('🎉 Вход в личный кабинет rs.ge выполнен. Читаю личную карточку...');
        const { report } = await executePaymentReconciliation({
            recordsRepository,
            rsGeClient: createRsGeBrowserClient(result.page)
        });

        await replyLongText(ctx, report);
    } catch (err) {
        logger.error('Ошибка при запуске /payments:', err);
        if (err.code !== 'USER_CANCELLED') {
            await ctx.reply(`❌ Ошибка сверки оплат: ${err.message}`);
        }
    } finally {
        if (sessionState.smsChatId === ctx.chat.id) {
            clearSmsWaitState();
        }
        if (result && result.browser) {
            await result.browser.close().catch((err) => {
                logger.warn('Не удалось закрыть браузер:', err.message);
            });
        }
        sessionState.fillInProgress = false;
        sessionState.fillChatId = null;
        sessionState.activeOperation = null;
    }
}

// Middleware: доступ только для владельца бота
bot.use(async (ctx, next) => {
    if (ALLOWED_CHAT_ID && ctx.chat && ctx.chat.id !== ALLOWED_CHAT_ID) {
        return ctx.reply('⛔ Доступ запрещен. Этот бот настроен на приватное использование владельцем.');
    }
    return next();
});

bot.catch(async (err, ctx) => {
    logger.error('Необработанная ошибка Telegram update:', err);
    try {
        await ctx.reply('❌ Внутренняя ошибка бота. Попробуйте повторить действие.');
    } catch (replyError) {
        logger.warn('Не удалось отправить сообщение об ошибке:', replyError.message);
    }
});

// Главная клавиатура
function getMainMenu() {
    return Markup.keyboard([
        ['➕ Добавить доход', '📊 Статус за месяц'],
        ['📝 Подать декларацию', '💳 Оплатить налог'],
        ['🔍 Проверить оплаты'],
        ['❓ Помощь']
    ]).resize();
}

// Клавиатура отмены мастера
function getCancelKeyboard() {
    return Markup.keyboard([['❌ Отмена']]).resize();
}

// Клавиатура выбора валюты
function getCurrencyKeyboard() {
    return Markup.keyboard([
        ['USD', 'EUR', 'GEL'],
        ['RUB', '❌ Отмена']
    ]).resize();
}

// /start
bot.start(async (ctx) => {
    const welcome = `👋 Привет! Я твой налоговый агент по Грузии (ИП, малый бизнес 1%).\n\n` +
        `Выбери нужное действие в меню снизу:\n\n` +
        `• ➕ *Добавить доход* — пошаговый ввод нового поступления (сумма, валюта, дата)\n` +
        `• 📊 *Статус за месяц* — сводка из Google Таблицы, налог 1% и сроки\n` +
        `• 📝 *Подать декларацию* — вход на rs.ge и заполнение декларации\n` +
        `• 💳 *Оплатить налог* — ссылка и реквизиты Казначейства\n` +
        `• 🔍 *Проверить оплаты* — сверка дат и сумм с личной карточкой RS.GE\n\n` +
        `💡 Также можно быстро отправить строку вида: \`15.10 2500 USD\``;

    await ctx.replyWithMarkdown(welcome, getMainMenu());
});

// Кнопка "➕ Добавить доход" или команда /add
bot.hears(['➕ Добавить доход', '/add'], async (ctx) => {
    const userId = ctx.from.id;
    sessionState.incomeWizard[userId] = { step: 'amount', data: {} };

    await ctx.reply(
        '💰 *Шаг 1 из 4: Введите сумму дохода*\n\n' +
        'Например: `2500` или `1500.50`',
        { parse_mode: 'Markdown', ...getCancelKeyboard() }
    );
});

// Отмена любого активного действия
bot.hears(['❌ Отмена', '/cancel'], async (ctx) => {
    const userId = ctx.from.id;
    delete sessionState.incomeWizard[userId];
    rejectSmsWait(
        ctx.chat.id,
        createFlowError('Авторизация отменена пользователем.', 'USER_CANCELLED')
    );
    await ctx.reply('Действие отменено.', getMainMenu());
});

// /help или кнопка "Помощь"
bot.hears(['❓ Помощь', '/help'], async (ctx) => {
    const helpText = `📖 *Как пользоваться ботом:*\n\n` +
        `1. *➕ Добавить доход (/add)*\n` +
        `Пошаговый мастер запросит сумму, валюту (USD/EUR/GEL), дату поступления и назначение. Бот сам обратится к Нацбанку Грузии (NBG), пересчитает сумму в лари по курсу на этот день и добавит запись в твою Google Таблицу.\n\n` +
        `2. *📊 Статус за месяц (/status)*\n` +
        `Показывает доходы из таблицы, налог 1% и подсказывает, когда открыто окно подачи.\n\n` +
        `3. *📝 Подать декларацию (/fill)*\n` +
        `Бот входит на rs.ge, запросит SMS прямо в этот чат, откроет форму декларации малого бизнеса и пришлет скриншот черновика.\n\n` +
        `4. *💳 Оплатить налог (/pay)*\n` +
        `Ссылка на официальный шлюз rs.ge и реквизиты Казначейства (101001000).\n\n` +
        `5. *🔍 Проверить оплаты (/payments)*\n` +
        `Читает личную карточку на RS.GE и сверяет даты и фактические суммы платежей с Google Таблицей. Таблица автоматически не изменяется.`;

    await ctx.replyWithMarkdown(helpText);
});

// /status или кнопка "📊 Статус за месяц"
bot.hears(['📊 Статус за месяц', '/status'], async (ctx) => {
    await ctx.reply('⏳ Запрашиваю данные из Google Таблицы...');

    try {
        const now = new Date();
        const curYear = now.getFullYear();
        const curMonth = now.getMonth() + 1;

        let reportYear = curYear;
        let reportMonth = curMonth - 1;
        if (reportMonth < 1) {
            reportMonth = 12;
            reportYear -= 1;
        }

        const periodInfo = rules.checkSubmissionPeriod(reportYear, reportMonth, now);
        const reportSummary = await sheets.getMonthlySummary(reportYear, reportMonth);
        const yearSummary = await sheets.getYearlySummary(reportYear, reportMonth);
        const curSummary = await sheets.getMonthlySummary(curYear, curMonth);
        const paymentStatus = reportSummary.isPaid
            ? `оплачен ${reportSummary.paymentDate}`
            : 'оплата не отмечена';

        let msg = `📅 *Отчетный период: ${String(reportMonth).padStart(2, '0')}.${reportYear}*\n\n` +
            `• Записей в таблице: ${reportSummary.recordsCount}\n` +
            `• Доход: *${reportSummary.totalIncomeGel.toFixed(2)} GEL*\n` +
            `• Налог 1%: *${reportSummary.totalTaxGel.toFixed(2)} GEL*\n` +
            `• Статус: _${reportSummary.status}_\n` +
            `• Оплата: _${paymentStatus}_\n` +
            `• Доход с начала ${reportYear} года: *${yearSummary.totalIncomeGel.toFixed(2)} GEL*\n\n` +
            `🗓 *Календарь подачи:*\n${periodInfo.message}\n\n` +
            `📈 *Текущий месяц (${String(curMonth).padStart(2, '0')}.${curYear}):*\n` +
            `• Доход: ${curSummary.totalIncomeGel.toFixed(2)} GEL (налог 1%: ${curSummary.totalTaxGel.toFixed(2)} GEL)`;

        await ctx.replyWithMarkdown(msg);
    } catch (err) {
        logger.error('Ошибка в /status:', err);
        await ctx.reply(`❌ Ошибка получения статуса: ${err.message}`);
    }
});

// /pay или кнопка "💳 Оплатить налог"
bot.hears(['💳 Оплатить налог', '/pay'], async (ctx) => {
    try {
        const now = new Date();
        let reportYear = now.getFullYear();
        let reportMonth = now.getMonth();
        if (reportMonth < 1) {
            reportMonth = 12;
            reportYear -= 1;
        }

        const reportSummary = await sheets.getMonthlySummary(reportYear, reportMonth);
        if (reportSummary.isPaid) {
            return ctx.reply(
                `✅ Налог за ${String(reportMonth).padStart(2, '0')}.${reportYear} уже отмечен оплаченным ` +
                `${reportSummary.paymentDate}. Повторную оплату не формирую.\n` +
                `Сумма по таблице: ${reportSummary.totalTaxGel.toFixed(2)} GEL.`
            );
        }

        const taxPayerId = config.rsGe.username;
        const details = rules.getPaymentDetails(taxPayerId, reportSummary.totalTaxGel);

        await ctx.reply(details.instructions, Markup.inlineKeyboard([
            [Markup.button.url('💳 Оплатить картой на RS.GE', details.paymentUrl)]
        ]));
    } catch (err) {
        await ctx.reply(`❌ Ошибка получения реквизитов: ${err.message}`);
    }
});

// /fill или кнопка "📝 Подать декларацию"
bot.hears(['📝 Подать декларацию', '/fill'], async (ctx) => {
    if (sessionState.fillInProgress) {
        return ctx.reply('⏳ Операция с RS.GE уже запущена. Отправьте SMS-код или нажмите /cancel.');
    }

    sessionState.fillInProgress = true;
    sessionState.fillChatId = ctx.chat.id;
    sessionState.activeOperation = 'fill';
    await ctx.reply('🚀 Запускаю процесс авторизации на rs.ge...\nЭто займет около 10-15 секунд.');

    // Не await: Telegram polling должен получить следующее сообщение с SMS-кодом.
    setImmediate(() => {
        runFillFlow(ctx).catch((err) => {
            logger.error('Фоновый процесс /fill завершился с ошибкой:', err);
        });
    });
});

// /payments или кнопка "🔍 Проверить оплаты"
bot.hears(['🔍 Проверить оплаты', '/payments'], async (ctx) => {
    if (sessionState.fillInProgress) {
        return ctx.reply('⏳ Операция с RS.GE уже запущена. Отправьте SMS-код или нажмите /cancel.');
    }

    sessionState.fillInProgress = true;
    sessionState.fillChatId = ctx.chat.id;
    sessionState.activeOperation = 'payments';
    await ctx.reply(
        '🔍 Сверяю Google Таблицу с личной карточкой RS.GE. ' +
        'Это только чтение: данные на портале и в таблице не изменятся.'
    );

    // Не await: Telegram polling должен продолжать принимать SMS-код.
    setImmediate(() => {
        runPaymentsFlow(ctx).catch((err) => {
            logger.error('Фоновый процесс /payments завершился с ошибкой:', err);
        });
    });
});

// Быстрый регулярный формат: "10.11 2500 USD", "5000 GEL"
const QUICK_INCOME_REGEX = /^(?:(\d{1,2}\.\d{1,2}(?:\.\d{2,4})?|\d{4}-\d{2}-\d{2})\s+)?(\d+(?:[.,]\d+)?)\s*([a-zA-Z]{3})(?:\s+(.*))?$/i;

// Обработка текстовых сообщений
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    const userId = ctx.from.id;

    // 1. Ожидание SMS-кода для rs.ge
    if (sessionState.waitingForSms && sessionState.smsChatId === ctx.chat.id) {
        if (!/^\d{4,8}$/.test(text)) {
            return ctx.reply('⚠️ Ожидаю SMS-код из 4–8 цифр или команду /cancel.');
        }

        if (resolveSmsCode(ctx.chat.id, text)) {
            await ctx.reply('Код получен, проверяю его на RS.GE...');
            return;
        }
    }

    // 2. Пошаговый мастер добавления дохода (Income Wizard)
    const wizard = sessionState.incomeWizard[userId];
    if (wizard) {
        if (wizard.step === 'amount') {
            const cleaned = text.replace(',', '.');
            const amount = parseFloat(cleaned);
            if (isNaN(amount) || amount <= 0) {
                return ctx.reply('⚠️ Введите корректное положительное число (например `3000`):', { parse_mode: 'Markdown' });
            }
            wizard.data.amount = amount;
            wizard.step = 'currency';
            return ctx.reply('💱 *Шаг 2 из 4: Выберите или введите валюту дохода:*', {
                parse_mode: 'Markdown',
                ...getCurrencyKeyboard()
            });
        }

        if (wizard.step === 'currency') {
            const cur = text.toUpperCase();
            if (!/^[A-Z]{3}$/.test(cur)) {
                return ctx.reply('⚠️ Укажите 3-буквенный код валюты (USD, EUR, GEL, RUB):', getCurrencyKeyboard());
            }
            wizard.data.currency = cur;
            wizard.step = 'date';
            const todayStr = new Date().toISOString().slice(0, 10);
            return ctx.reply(
                `📅 *Шаг 3 из 4: Укажите дату поступления платежа*\n\n` +
                `Формат: \`ДД.ММ.ГГГГ\` (например \`15.10.2026\`) или напишите \`сегодня\` (по умолчанию: \`${todayStr}\`):`,
                { parse_mode: 'Markdown', ...getCancelKeyboard() }
            );
        }

        if (wizard.step === 'date') {
            let targetDate;
            if (text.toLowerCase() === 'сегодня') {
                targetDate = new Date().toISOString().slice(0, 10);
            } else {
                targetDate = nbg.formatDate(text);
            }
            wizard.data.date = targetDate;
            wizard.step = 'desc';
            return ctx.reply(
                `📝 *Шаг 4 из 4: Укажите описание / источник платежа*\n\n` +
                `Например: \`Upwork\`, \`Зарплата разработчика\`, \`Банковский перевод TBC\`:`,
                { parse_mode: 'Markdown', ...getCancelKeyboard() }
            );
        }

        if (wizard.step === 'desc') {
            wizard.data.description = text;
            const data = wizard.data;
            delete sessionState.incomeWizard[userId];

            await ctx.reply(`⏳ Запрашиваю курс NBG на ${data.date} и сохраняю...`, getMainMenu());

            try {
                const converted = await nbg.convertToGel(data.amount, data.currency, data.date);
                const tax = rules.calculateSmallBusinessTax(converted.amountGel);

                const addResult = await sheets.addIncomeRecord({
                    date: converted.date,
                    amountOriginal: converted.amountOriginal,
                    currency: converted.currency,
                    rate: converted.rate,
                    amountGel: converted.amountGel,
                    taxGel: tax.taxAmount,
                    description: data.description,
                    status: 'Ожидает подачи'
                });

                let replyMsg = addResult.added
                    ? `✅ *Доход успешно записан в Google Таблицу!*\n\n`
                    : `⚠️ *${addResult.message}*\n\n`;

                replyMsg += `📅 Дата: ${converted.date}\n` +
                    `💵 Сумма: ${converted.amountOriginal} ${converted.currency}\n` +
                    (converted.currency !== 'GEL' ? `🏛 Курс NBG: ${converted.rate.toFixed(4)}\n` : '') +
                    `🇬🇪 Сумма в лари: *${converted.amountGel.toFixed(2)} GEL*\n` +
                    `🧾 Налог 1%: *${tax.taxAmount.toFixed(2)} GEL*\n` +
                    `📝 Назначение: ${data.description}`;

                return ctx.replyWithMarkdown(replyMsg, getMainMenu());
            } catch (err) {
                logger.error('Ошибка сохранения дохода через мастер:', err);
                return ctx.reply(`❌ Ошибка сохранения: ${err.message}`, getMainMenu());
            }
        }
    }

    // 3. Быстрый формат: "10.11 2500 USD"
    const match = text.match(QUICK_INCOME_REGEX);
    if (match) {
        const rawDate = match[1];
        const rawAmount = parseFloat(match[2].replace(',', '.'));
        const currency = match[3].toUpperCase();
        const description = match[4] || 'Банковский перевод';

        await ctx.reply(`⏳ Запрашиваю официальный курс NBG на ${rawDate || 'сегодня'}...`);

        try {
            const date = nbg.formatDate(rawDate);
            const converted = await nbg.convertToGel(rawAmount, currency, date);
            const tax = rules.calculateSmallBusinessTax(converted.amountGel);

            const addResult = await sheets.addIncomeRecord({
                date: converted.date,
                amountOriginal: converted.amountOriginal,
                currency: converted.currency,
                rate: converted.rate,
                amountGel: converted.amountGel,
                taxGel: tax.taxAmount,
                description,
                status: 'Ожидает подачи'
            });

            let replyMsg = addResult.added
                ? `✅ *Доход успешно записан в Google Таблицу!*\n\n`
                : `⚠️ *${addResult.message}*\n\n`;

            replyMsg += `📅 Дата: ${converted.date}\n` +
                `💵 Сумма: ${converted.amountOriginal} ${converted.currency}\n` +
                (currency !== 'GEL' ? `🏛 Курс NBG: ${converted.rate.toFixed(4)}\n` : '') +
                `🇬🇪 Сумма в лари: *${converted.amountGel.toFixed(2)} GEL*\n` +
                `🧾 Налог 1%: *${tax.taxAmount.toFixed(2)} GEL*\n` +
                `📝 Назначение: ${description}`;

            return ctx.replyWithMarkdown(replyMsg, getMainMenu());
        } catch (err) {
            logger.error('Ошибка добавления дохода:', err);
            return ctx.reply(`❌ Ошибка: ${err.message}`, getMainMenu());
        }
    }

    return ctx.reply('ℹ️ Выберите команду в меню снизу или нажмите *➕ Добавить доход*', {
        parse_mode: 'Markdown',
        ...getMainMenu()
    });
});

module.exports = {
    bot,
    sessionState
};
