const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSqliteIncomeRepository } = require('../connectors/sqlite/income-repository');
const { executeModuleAction } = require('../core/action-contract');
const smallBusinessModule = require('../modules/small-business/manifest');
const { buildIncomeImportPreview, importFingerprint, importIdempotencyKey } = require('../workflows/income-import');

function repository(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ge-import-'));
    const result = createSqliteIncomeRepository({ filePath: path.join(directory, 'ledger.sqlite') });
    t.after(() => { result.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    return result;
}

const now = new Date('2026-11-20T12:00:00+04:00');
const convertToGel = async (amount, currency) => ({
    rate: currency === 'GEL' ? 1 : 2.7,
    amountGel: Number((amount * (currency === 'GEL' ? 1 : 2.7)).toFixed(2))
});
const parsed = { portalRows: 1, items: [
    { line: 2, input: { date: '2026-11-18', amount: '100', currency: 'USD', description: 'First', paymentDate: '' } },
    { line: 3, input: { date: '2026-11-19', amount: '50', currency: 'USD', description: 'Second', paymentDate: '' } },
    { line: 4, input: { date: '2026-11-18', amount: '100', currency: 'USD', description: 'Duplicate', paymentDate: '' } }
] };

test('file import previews duplicates and writes both new incomes only after confirmation', async (t) => {
    const recordsRepository = repository(t);
    const preview = await buildIncomeImportPreview({ parsed, recordsRepository, convertToGel, now });
    assert.equal(preview.importable.length, 2);
    assert.equal(preview.duplicates.length, 1);
    assert.equal(preview.errors.length, 0);
    assert.equal(preview.totalIncomeGel, 405);
    assert.equal((await recordsRepository.getAllRecords()).length, 0);
    const auditLog = { async record() {} };
    const input = { parsed, recordsRepository, convertToGel, now, auditLog,
        confirmedFingerprint: importFingerprint(preview) };
    await assert.rejects(executeModuleAction(smallBusinessModule, 'import-income', input),
        { code: 'CONFIRMATION_REQUIRED' });
    const result = await executeModuleAction(smallBusinessModule, 'import-income', input,
        { confirmed: true, idempotencyKey: importIdempotencyKey(preview) });
    assert.equal(result.result.imported, 2);
    assert.equal((await recordsRepository.getMonthlySummary(2026, 11)).totalIncomeGel, 405);
});

test('file import rejects a stale preview and a period followed by a filed declaration', async (t) => {
    const recordsRepository = repository(t);
    const preview = await buildIncomeImportPreview({ parsed, recordsRepository, convertToGel, now });
    await recordsRepository.addIncomeRecord({ date: '2026-11-20', amountOriginal: 1, currency: 'GEL',
        rate: 1, amountGel: 1, taxGel: 0.01, description: 'Concurrent', status: 'Ожидает подачи' });
    await assert.rejects(executeModuleAction(smallBusinessModule, 'import-income', {
        parsed, recordsRepository, convertToGel, now, auditLog: { async record() {} },
        confirmedFingerprint: importFingerprint(preview)
    }, { confirmed: true, idempotencyKey: importIdempotencyKey(preview) }), { code: 'IMPORT_PREVIEW_STALE' });
    await recordsRepository.addIncomeRecord({ date: '2026-12-01', amountOriginal: 2, currency: 'GEL',
        rate: 1, amountGel: 2, taxGel: 0.02, description: 'Filed later', status: 'Подана' });
    const blocked = await buildIncomeImportPreview({ parsed, recordsRepository, convertToGel, now });
    assert.equal(blocked.importable.length, 0);
    assert.equal(blocked.errors.length, 3);
});

test('SQLite rolls back the whole file import if a duplicate appears within its batch', async (t) => {
    const recordsRepository = repository(t);
    const record = { date: '2026-11-18', amountOriginal: 100, currency: 'USD', rate: 2.7,
        amountGel: 270, taxGel: 2.7, description: 'One', status: 'Ожидает подачи' };
    await assert.rejects(recordsRepository.addIncomeRecords([record, { ...record, description: 'Two' }]),
        { code: 'INCOME_DUPLICATE' });
    assert.equal((await recordsRepository.getAllRecords()).length, 0);
});
