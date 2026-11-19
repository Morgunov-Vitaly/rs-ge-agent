const test = require('node:test');
const assert = require('node:assert/strict');

test('Telegram writes reconciliation data only after explicit DATA_WRITE confirmation', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '999999:test-token';
    process.env.TELEGRAM_CHAT_ID = '123456';

    const playwright = require('../services/playwright');
    const sheets = require('../services/sheets');
    const { auditLog } = require('../infrastructure/audit-log');
    const originals = {
        loginToRsGe: playwright.loginToRsGe,
        getPaymentHistory: playwright.getPaymentHistory,
        getAllRecords: sheets.getAllRecords,
        applyPaymentReconciliationPlan: sheets.applyPaymentReconciliationPlan,
        auditRecord: auditLog.record
    };
    const records = [{
        rowIndex: 2,
        date: '2026-10-20',
        taxGel: 72.78,
        paymentDate: '17.11.2026'
    }];
    const portalHistory = {
        payments: [
            {
                paymentDate: '2026-11-17',
                postedDate: '2026-11-18',
                amount: 73,
                reference: 'fixture-matched'
            },
            {
                paymentDate: '2026-08-01',
                postedDate: '2026-08-02',
                amount: 12,
                reference: 'fixture-untracked'
            }
        ],
        charges: [],
        balance: { debt: 0, overpayment: 0 }
    };
    let submittedCode;
    let applyCalls = 0;
    let appliedPlan;

    playwright.loginToRsGe = async (onSmsRequired) => {
        submittedCode = await onSmsRequired(Buffer.from('fake login screenshot'));
        return { browser: { close: async () => undefined }, page: {}, isLoggedIn: true };
    };
    playwright.getPaymentHistory = async () => portalHistory;
    sheets.getAllRecords = async () => records;
    sheets.applyPaymentReconciliationPlan = async (plan) => {
        applyCalls += 1;
        appliedPlan = plan;
        return { updatedRows: plan.updates.length, insertedRows: plan.inserts.length };
    };
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
                text: 'reconciliation preview'
            },
            chat_instance: 'test-chat',
            data
        }
    });
    const waitFor = async (predicate, timeoutMs = 2000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() >= deadline) throw new Error('Timed out waiting for reconciliation flow');
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };

    try {
        await bot.handleUpdate(messageUpdate(1, '/reconcile'));
        await waitFor(() => sessionState.waitingForSms);
        await bot.handleUpdate(messageUpdate(2, '1234'));
        await waitFor(() => Boolean(sessionState.reconciliationConfirmation));

        assert.equal(submittedCode, '1234');
        assert.equal(applyCalls, 0);
        const previewCall = telegramCalls.find(({ payload }) => (
            payload?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data
                ?.startsWith('reconcile_confirm:')
        ));
        assert.ok(previewCall);
        assert.match(previewCall.payload.text, /DATA_WRITE/);
        assert.match(previewCall.payload.text, /Исходные колонки A–I не изменяются/);

        const callbackData = previewCall.payload.reply_markup.inline_keyboard[0][0].callback_data;
        await bot.handleUpdate(callbackUpdate(3, callbackData));
        await waitFor(() => !sessionState.fillInProgress);

        assert.equal(applyCalls, 1);
        assert.equal(appliedPlan.updates.length, 1);
        assert.equal(appliedPlan.inserts.length, 1);
        assert.ok(telegramCalls.some(({ payload }) => (
            String(payload?.text || '').includes('Сверка записана в Google Sheets')
        )));
    } finally {
        playwright.loginToRsGe = originals.loginToRsGe;
        playwright.getPaymentHistory = originals.getPaymentHistory;
        sheets.getAllRecords = originals.getAllRecords;
        sheets.applyPaymentReconciliationPlan = originals.applyPaymentReconciliationPlan;
        auditLog.record = originals.auditRecord;
        Telegram.prototype.callApi = originalCallApi;
    }
});
