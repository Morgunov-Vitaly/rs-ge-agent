const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, assertConfig } = require('../config');
const {
    ACTION_RISKS,
    defineModule,
    requiresConfirmation,
    executeModuleAction
} = require('../core/action-contract');
const { sanitize } = require('../infrastructure/audit-log');
const { executePaymentReconciliation } = require('../workflows/payment-reconciliation');
const smallBusinessModule = require('../modules/small-business/manifest');

function createMemoryAuditLog() {
    const events = [];
    return {
        events,
        async record(event) {
            events.push(event);
            return event;
        }
    };
}

test('configuration is structured and validated by scope', () => {
    const config = loadConfig({
        TELEGRAM_BOT_TOKEN: 'test-token',
        GOOGLE_SPREADSHEET_ID: 'sheet-id',
        GOOGLE_CREDENTIALS_PATH: './credentials.json'
    });

    assert.equal(config.telegram.token, 'test-token');
    assert.match(config.rsGe.screenshotsDir, /screenshots[\\/]tmp$/);
    assert.equal(config.runtime.retention.logMaxSizeBytes, 10 * 1024 * 1024);
    assert.equal(config.runtime.retention.screenshotTtlHours, 24);
    assert.doesNotThrow(() => assertConfig(config, ['telegram', 'google']));
    assert.throws(() => assertConfig(config, ['rsge']), /RS_USERNAME, RS_PASSWORD/);
});

test('module contract rejects unsafe or incomplete actions', () => {
    assert.equal(requiresConfirmation(ACTION_RISKS.READ_ONLY), false);
    assert.equal(requiresConfirmation(ACTION_RISKS.IRREVERSIBLE), true);
    assert.throws(() => defineModule({
        id: 'invalid-module',
        version: '1.0.0',
        actions: [{ id: 'submit', risk: ACTION_RISKS.IRREVERSIBLE }]
    }), /handler/);

    assert.equal(smallBusinessModule.id, 'small-business');
    assert.deepEqual(
        smallBusinessModule.actions.map(({ risk }) => risk),
        [ACTION_RISKS.READ_ONLY, ACTION_RISKS.READ_ONLY]
    );
});

test('module executor blocks write actions without confirmation and idempotency', async () => {
    const manifest = defineModule({
        id: 'write-test',
        version: '1.0.0',
        actions: [{
            id: 'submit',
            risk: ACTION_RISKS.IRREVERSIBLE,
            handler: async ({ value }) => value
        }]
    });

    await assert.rejects(
        executeModuleAction(manifest, 'submit', { value: 1 }),
        ({ code }) => code === 'CONFIRMATION_REQUIRED'
    );
    await assert.rejects(
        executeModuleAction(manifest, 'submit', { value: 1 }, { confirmed: true }),
        ({ code }) => code === 'IDEMPOTENCY_KEY_REQUIRED'
    );
    assert.equal(await executeModuleAction(
        manifest,
        'submit',
        { value: 42 },
        { confirmed: true, idempotencyKey: 'unique-operation-id' }
    ), 42);
});

test('audit sanitization removes credentials recursively', () => {
    assert.deepEqual(sanitize({
        years: [2025, 2026],
        password: 'secret',
        nested: { smsCode: '1234', result: 'ok' }
    }), {
        years: [2025, 2026],
        password: '[REDACTED]',
        nested: { smsCode: '[REDACTED]', result: 'ok' }
    });
});

test('payment workflow depends on connector contracts, not Telegram or Playwright', async () => {
    const auditLog = createMemoryAuditLog();
    const recordsRepository = {
        async getAllRecords() {
            return [{ date: '2026-10-20', taxGel: 72.78, paymentDate: '17.11.2026' }];
        }
    };
    const rsGeClient = {
        async getPaymentHistory({ years }) {
            assert.deepEqual(years, [2026]);
            return {
                payments: [{ paymentDate: '2026-11-17', amount: 73 }],
                charges: [{ amount: 72.78 }],
                balance: { debt: 0, overpayment: 0 }
            };
        }
    };

    const result = await executePaymentReconciliation({
        recordsRepository,
        rsGeClient,
        auditLog,
        currentYear: 2026
    });

    assert.equal(result.reconciliation.matchedCount, 1);
    assert.match(result.report, /Подтверждено: 1/);
    assert.deepEqual(auditLog.events.map(({ status }) => status), ['started', 'completed']);
    assert.equal(auditLog.events[1].risk, ACTION_RISKS.READ_ONLY);
});
