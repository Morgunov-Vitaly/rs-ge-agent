const test = require('node:test');
const assert = require('node:assert/strict');
process.env.STORAGE_DRIVER = 'sheets';

test('Telegram requires a separate IRREVERSIBLE confirmation before final submit', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '999999:test-token';
    process.env.TELEGRAM_CHAT_ID = '123456';
    process.env.RSGE_ENABLE_SUBMISSION = 'true';
    process.env.RSGE_EVIDENCE_KEY = Buffer.alloc(32, 9).toString('base64');

    const playwright = require('../services/playwright');
    const sheets = require('../services/sheets');
    const { auditLog } = require('../infrastructure/audit-log');
    const { evidenceStore } = require('../infrastructure/evidence-store');
    const originals = {
        loginToRsGe: playwright.loginToRsGe,
        openExistingSmallBusinessDraft: playwright.openExistingSmallBusinessDraft,
        submitSmallBusinessDeclaration: playwright.submitSmallBusinessDeclaration,
        getMonthlySummary: sheets.getMonthlySummary,
        getYearlySummary: sheets.getYearlySummary,
        auditRecord: auditLog.record,
        saveEvidence: evidenceStore.saveDeclarationSubmission
    };
    const fields = {
        15: 12000.5,
        16: 1,
        17: 2000.5,
        18: 0,
        19: 0,
        20: 2000.5,
        21: 0,
        26: 20.01
    };
    let submittedCode;
    let submitCalls = 0;

    playwright.loginToRsGe = async (onSmsRequired) => {
        submittedCode = await onSmsRequired(Buffer.from('fake login screenshot'));
        return {
            browser: { close: async () => undefined },
            page: {},
            isLoggedIn: true
        };
    };
    playwright.openExistingSmallBusinessDraft = async () => ({
        exists: true,
        status: 'Сохранен',
        fields: { ...fields },
        screenshotBuffer: Buffer.from('fake draft screenshot')
    });
    playwright.submitSmallBusinessDeclaration = async () => {
        submitCalls += 1;
        return {
            exists: true,
            status: 'Sent',
            fields: { ...fields },
            screenshotBuffer: Buffer.from('fake submitted screenshot'),
            pdfBuffer: Buffer.from('fake submitted pdf')
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
    evidenceStore.saveDeclarationSubmission = async () => ({
        artifacts: [{ type: 'pdf', fileName: 'proof.pdf', sha256: 'abc', bytes: 18 }]
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
                text: 'submission preview'
            },
            chat_instance: 'test-chat',
            data
        }
    });
    const waitFor = async (predicate, timeoutMs = 2500) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };

    try {
        await bot.handleUpdate(messageUpdate(1, '/submit'));
        await waitFor(() => sessionState.waitingForSms);
        await bot.handleUpdate(messageUpdate(2, '1234'));
        await waitFor(() => Boolean(sessionState.submissionConfirmation));

        assert.equal(submittedCode, '1234');
        assert.equal(submitCalls, 0, 'declaration must not be submitted before confirmation');
        const previewCall = telegramCalls.find(({ payload }) => (
            payload?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('submit_confirm:')
        ));
        assert.ok(previewCall, 'bot should send a separate IRREVERSIBLE confirmation');
        assert.match(previewCall.payload.text, /IRREVERSIBLE/);
        assert.match(previewCall.payload.text, /нельзя отменить/);

        const callbackData = previewCall.payload.reply_markup.inline_keyboard[0][0].callback_data;
        await bot.handleUpdate(callbackUpdate(3, callbackData));
        await waitFor(() => !sessionState.fillInProgress);

        assert.equal(submitCalls, 1);
        assert.ok(telegramCalls.some(({ payload }) => (
            String(payload?.caption || '').includes('отправлена') &&
            String(payload?.caption || '').includes('SHA-256')
        )));
        assert.ok(telegramCalls.some(({ method }) => method === 'sendDocument'));
    } finally {
        playwright.loginToRsGe = originals.loginToRsGe;
        playwright.openExistingSmallBusinessDraft = originals.openExistingSmallBusinessDraft;
        playwright.submitSmallBusinessDeclaration = originals.submitSmallBusinessDeclaration;
        sheets.getMonthlySummary = originals.getMonthlySummary;
        sheets.getYearlySummary = originals.getYearlySummary;
        auditLog.record = originals.auditRecord;
        evidenceStore.saveDeclarationSubmission = originals.saveEvidence;
        Telegram.prototype.callApi = originalCallApi;
    }
});
