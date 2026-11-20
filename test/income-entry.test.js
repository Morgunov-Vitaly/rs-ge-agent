const test = require('node:test');
const assert = require('node:assert/strict');
const { executeModuleAction } = require('../core/action-contract');
const manifest = require('../modules/small-business/manifest');
const { buildIncomePreview, incomeFingerprint, incomeIdempotencyKey } = require('../workflows/income-entry');

function fixture() {
    const writes = [];
    const repository = {
        async getAllRecords() { return [...writes]; },
        async getMonthlySummary() { return { totalIncomeGel: 0 }; },
        async getYearlySummary() { return { totalIncomeGel: 0 }; },
        async addIncomeRecord(record) { writes.push(record); return { added: true }; }
    };
    return { writes, repository };
}

test('income preview needs explicit confirmation and writes exactly once', async () => {
    const { writes, repository } = fixture();
    const rawInput = { date: '2026-11-20', amount: '100.00', currency: 'USD', description: 'Клиент' };
    const convertToGel = async () => ({ rate: 2.7, amountGel: 270 });
    const now = new Date('2026-11-20T01:00:00+04:00');
    const preview = await buildIncomePreview({ input: rawInput, convertToGel, recordsRepository: repository, now });
    assert.equal(preview.record.amountGel, 270);
    assert.equal(preview.record.taxGel, 2.7);
    assert.equal(writes.length, 0);
    const input = {
        rawInput, convertToGel, recordsRepository: repository, now,
        previewFingerprint: incomeFingerprint(preview),
        auditLog: { async record() {} }
    };
    await assert.rejects(
        executeModuleAction(manifest, 'add-income', input, { idempotencyKey: incomeIdempotencyKey(preview) }),
        { code: 'CONFIRMATION_REQUIRED' }
    );
    assert.equal(writes.length, 0);
    await executeModuleAction(manifest, 'add-income', input, { confirmed: true, idempotencyKey: incomeIdempotencyKey(preview) });
    assert.equal(writes.length, 1);
    await assert.rejects(
        executeModuleAction(manifest, 'add-income', input, { confirmed: true, idempotencyKey: incomeIdempotencyKey(preview) }),
        { code: 'INCOME_DUPLICATE' }
    );
    assert.equal(writes.length, 1);
});

test('income write rejects changed NBG rate before sheet mutation', async () => {
    const { writes, repository } = fixture();
    const rawInput = { date: '2026-11-19', amount: '100', currency: 'USD', description: 'Клиент' };
    let rate = 2.7;
    const convertToGel = async () => ({ rate, amountGel: rate * 100 });
    const preview = await buildIncomePreview({ input: rawInput, convertToGel, recordsRepository: repository });
    rate = 2.8;
    await assert.rejects(
        executeModuleAction(manifest, 'add-income', {
            rawInput, convertToGel, recordsRepository: repository,
            previewFingerprint: incomeFingerprint(preview),
            auditLog: { async record() {} }
        }, { confirmed: true, idempotencyKey: incomeIdempotencyKey(preview) }),
        { code: 'INCOME_PREVIEW_STALE' }
    );
    assert.equal(writes.length, 0);
});

test('income preview detects a duplicate even when the sheet uses Georgian display dates', async () => {
    const repository = {
        async getAllRecords() { return [{ date: '19.11.2026', amountOriginal: 100, currency: 'USD' }]; },
        async getMonthlySummary() { return { totalIncomeGel: 0 }; },
        async getYearlySummary() { return { totalIncomeGel: 0 }; }
    };
    await assert.rejects(
        buildIncomePreview({
            input: { date: '2026-11-19', amount: '100', currency: 'USD', description: 'Клиент' },
            convertToGel: async () => ({ rate: 2.7, amountGel: 270 }),
            recordsRepository: repository,
            now: new Date('2026-11-20T12:00:00+04:00')
        }),
        { code: 'INCOME_DUPLICATE' }
    );
});
