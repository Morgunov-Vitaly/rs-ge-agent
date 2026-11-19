const test = require('node:test');
const assert = require('node:assert/strict');

test('Telegram requires an inline confirmation before creating a draft', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '999999:test-token';
    process.env.TELEGRAM_CHAT_ID = '123456';

    const playwright = require('../services/playwright');
    const sheets = require('../services/sheets');
    const { auditLog } = require('../infrastructure/audit-log');
    const originals = {
        loginToRsGe: playwright.loginToRsGe,
        openExistingSmallBusinessDraft: playwright.openExistingSmallBusinessDraft,
        createSmallBusinessDraft: playwright.createSmallBusinessDraft,
        getMonthlySummary: sheets.getMonthlySummary,
        getYearlySummary: sheets.getYearlySummary,
        auditRecord: auditLog.record
    };
    let submittedCode;
    let createCalls = 0;

    playwright.loginToRsGe = async (onSmsRequired) => {
        submittedCode = await onSmsRequired(Buffer.from('fake login screenshot'));
        return {
            browser: { close: async () => undefined },
            page: {},
            isLoggedIn: true
        };
    };
    playwright.openExistingSmallBusinessDraft = async () => ({ exists: false });
    playwright.createSmallBusinessDraft = async (_page, preview) => {
        createCalls += 1;
        return {
            exists: true,
            status: 'Сохранен',
            fields: { ...preview.fields },
            screenshotBuffer: Buffer.from('fake saved draft screenshot')
        };
    };
    sheets.getMonthlySummary = async () => ({
        recordsCount: 2,
        totalIncomeGel: 2000.5,
        totalTaxGel: 20.01,
        isFiled: false,
        isPaid: false,
        status: 'Ожидает подачи'
    });
    sheets.getYearlySummary = async () => ({ totalIncomeGel: 12000.5 });
    auditLog.record = async (event) => event;

    const { Telegram } = require('telegraf');
    const originalCallApi = Telegram.prototype.callApi;
    const telegramCalls = [];
    Telegram.prototype.callApi = async function callApi(method, payload) {
        telegramCalls.push({ method, payload });
        return { message_id: telegramCalls.length, chat: { id: 123456 } };
    };

    const { bot, sessionState } = require('../services/bot');
    bot.botInfo = {
        id: 999999,
        is_bot: true,
        first_name: 'Test',
        username: 'test_bot'
    };

    const messageUpdate = (updateId, text) => ({
        update_id: updateId,
        message: {
            message_id: updateId,
            date: Math.floor(Date.now() / 1000),
            from: { id: 123456, is_bot: false, first_name: 'Owner' },
            chat: { id: 123456, type: 'private' },
            text
        }
    });
    const callbackUpdate = (updateId, data) => ({
        update_id: updateId,
        callback_query: {
            id: `callback-${updateId}`,
            from: { id: 123456, is_bot: false, first_name: 'Owner' },
            message: {
                message_id: updateId,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 123456, type: 'private' },
                text: 'preview'
            },
            chat_instance: 'test-chat',
            data
        }
    });
    const waitFor = async (predicate, timeoutMs = 2000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };

    try {
        await bot.handleUpdate(messageUpdate(1, '/fill'));
        await waitFor(() => sessionState.waitingForSms);
        await bot.handleUpdate(messageUpdate(2, '1234'));
        await waitFor(() => Boolean(sessionState.draftConfirmation));

        assert.equal(submittedCode, '1234');
        assert.equal(createCalls, 0, 'draft must not be created before confirmation');
        const previewCall = telegramCalls.find(({ payload }) => (
            payload?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('draft_confirm:')
        ));
        assert.ok(previewCall, 'bot should send a DRAFT_WRITE preview with confirmation button');
        assert.match(previewCall.payload.text, /Декларация НЕ будет отправлена/);

        const callbackData = previewCall.payload.reply_markup.inline_keyboard[0][0].callback_data;
        await bot.handleUpdate(callbackUpdate(3, callbackData));
        await waitFor(() => !sessionState.fillInProgress);

        assert.equal(createCalls, 1);
        assert.ok(telegramCalls.some(({ payload }) => (
            String(payload?.caption || '').includes('Черновик создан') &&
            String(payload?.caption || '').includes('НЕ отправлена')
        )));
    } finally {
        playwright.loginToRsGe = originals.loginToRsGe;
        playwright.openExistingSmallBusinessDraft = originals.openExistingSmallBusinessDraft;
        playwright.createSmallBusinessDraft = originals.createSmallBusinessDraft;
        sheets.getMonthlySummary = originals.getMonthlySummary;
        sheets.getYearlySummary = originals.getYearlySummary;
        auditLog.record = originals.auditRecord;
        Telegram.prototype.callApi = originalCallApi;
    }
});
