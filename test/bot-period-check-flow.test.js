const test = require('node:test');
const assert = require('node:assert/strict');

test('/check alias completes the unified read-only account verification after SMS', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '999999:test-token';
    process.env.TELEGRAM_CHAT_ID = '123456';

    const now = new Date();
    let reportYear = now.getFullYear();
    let reportMonth = now.getMonth();
    if (reportMonth < 1) {
        reportMonth = 12;
        reportYear -= 1;
    }
    const incomeDate = `${reportYear}-${String(reportMonth).padStart(2, '0')}-20`;
    const paymentDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-17`;

    const playwright = require('../services/playwright');
    const originals = {
        loginToRsGe: playwright.loginToRsGe,
        openExistingSmallBusinessDraft: playwright.openExistingSmallBusinessDraft,
        getPaymentHistory: playwright.getPaymentHistory
    };
    const sheets = require('../services/sheets');
    const originalSheets = {
        getMonthlySummary: sheets.getMonthlySummary,
        getYearlySummary: sheets.getYearlySummary,
        getAllRecords: sheets.getAllRecords
    };
    let submittedCode;

    playwright.loginToRsGe = async (onSmsRequired) => {
        submittedCode = await onSmsRequired(Buffer.from('fake screenshot'));
        return { browser: { close: async () => undefined }, page: {}, isLoggedIn: true };
    };
    playwright.openExistingSmallBusinessDraft = async () => ({
        exists: true,
        status: 'Sent',
        fields: { 15: 7277.76, 20: 7277.76, 26: 72.78 },
        metadata: { submittedAt: '17.11.2026 21:16' },
        screenshotBuffer: Buffer.from('fake declaration')
    });
    playwright.getPaymentHistory = async () => ({
        payments: [{ paymentDate, amount: 73 }],
        charges: [],
        balance: { debt: 0, overpayment: 0 }
    });
    sheets.getMonthlySummary = async () => ({
        totalIncomeGel: 7277.76,
        totalTaxGel: 72.78,
        isFiled: true,
        isPaid: true,
        paymentDate,
        status: 'Подана'
    });
    sheets.getYearlySummary = async () => ({ totalIncomeGel: 7277.76 });
    sheets.getAllRecords = async () => ([{
        date: incomeDate,
        taxGel: 72.78,
        paymentDate
    }]);

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
            if (Date.now() >= deadline) throw new Error('Timed out waiting for /check');
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };

    try {
        await bot.handleUpdate(createUpdate(1, '/check'));
        await waitFor(() => sessionState.waitingForSms);
        await bot.handleUpdate(createUpdate(2, '1234'));
        await waitFor(() => !sessionState.fillInProgress);

        assert.equal(submittedCode, '1234');
        assert.ok(telegramCalls.some(({ payload }) => (
            String(payload?.text || '').includes(`Период ${String(reportMonth).padStart(2, '0')}.${reportYear} закрыт`)
        )));
        assert.ok(telegramCalls.some(({ payload }) => (
            String(payload?.text || '').includes('История оплат')
        )));
        assert.ok(telegramCalls.some(({ payload }) => (
            String(payload?.text || '').includes('Проверка выполнена в режиме чтения')
        )));
    } finally {
        Object.assign(playwright, originals);
        Object.assign(sheets, originalSheets);
        Telegram.prototype.callApi = originalCallApi;
    }
});
