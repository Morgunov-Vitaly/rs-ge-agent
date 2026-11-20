const test = require('node:test');
const assert = require('node:assert/strict');
process.env.STORAGE_DRIVER = 'sheets';

test('SMS update continues /fill without blocking Telegram polling', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '999999:test-token';
    process.env.TELEGRAM_CHAT_ID = '123456';

    const playwright = require('../services/playwright');
    const originalLogin = playwright.loginToRsGe;
    const originalOpenDraft = playwright.openExistingSmallBusinessDraft;
    const sheets = require('../services/sheets');
    const originalGetMonthlySummary = sheets.getMonthlySummary;
    const originalGetYearlySummary = sheets.getYearlySummary;
    let submittedCode;

    playwright.loginToRsGe = async (onSmsRequired) => {
        submittedCode = await onSmsRequired(Buffer.from('fake screenshot'));
        return {
            browser: { close: async () => undefined },
            page: {},
            isLoggedIn: true
        };
    };
    playwright.openExistingSmallBusinessDraft = async () => ({
        exists: true,
        status: 'Сохранен',
        fields: { 15: 100, 20: 100, 26: 1 },
        screenshotBuffer: Buffer.from('fake draft screenshot')
    });
    sheets.getMonthlySummary = async () => ({
        totalIncomeGel: 100,
        totalTaxGel: 1
    });
    sheets.getYearlySummary = async () => ({
        totalIncomeGel: 100,
        totalTaxGel: 1
    });

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

    const createUpdate = (updateId, text) => ({
        update_id: updateId,
        message: {
            message_id: updateId,
            date: Math.floor(Date.now() / 1000),
            from: { id: 123456, is_bot: false, first_name: 'Owner' },
            chat: { id: 123456, type: 'private' },
            text
        }
    });

    const waitFor = async (predicate, timeoutMs = 1000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() >= deadline) {
                throw new Error('Timed out waiting for test condition');
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };

    try {
        const startedAt = Date.now();
        await bot.handleUpdate(createUpdate(1, '/fill'));
        assert.ok(Date.now() - startedAt < 500, '/fill handler should return before SMS arrives');

        await waitFor(() => sessionState.waitingForSms);
        await bot.handleUpdate(createUpdate(2, '1234'));
        await waitFor(() => !sessionState.fillInProgress);

        assert.equal(submittedCode, '1234');
        assert.equal(sessionState.waitingForSms, false);
        assert.ok(
            telegramCalls.some(({ payload }) => payload && String(payload.text).includes('Код получен')),
            'bot should acknowledge the SMS update'
        );
        assert.ok(
            telegramCalls.some(({ payload }) => payload && String(payload.text).includes('Успешный вход')),
            'background flow should continue after SMS'
        );
    } finally {
        playwright.loginToRsGe = originalLogin;
        playwright.openExistingSmallBusinessDraft = originalOpenDraft;
        sheets.getMonthlySummary = originalGetMonthlySummary;
        sheets.getYearlySummary = originalGetYearlySummary;
        Telegram.prototype.callApi = originalCallApi;
    }
});
