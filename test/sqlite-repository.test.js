const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSqliteIncomeRepository } = require('../connectors/sqlite/income-repository');
const { migrationPlan } = require('../scripts/migrate-sheets-to-sqlite');
const { createDailySqliteBackup } = require('../infrastructure/sqlite-backup');

function database(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ge-db-test-'));
    const filePath = path.join(dir, 'ledger.sqlite');
    const repository = createSqliteIncomeRepository({ filePath });
    t.after(() => { repository.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { repository, dir, filePath };
}

function income(overrides = {}) {
    return {
        date: '2026-11-19', amountOriginal: 100, currency: 'USD', rate: 2.7,
        amountGel: 270, taxGel: 2.7, paymentDate: '', description: 'Contract',
        status: 'Ожидает подачи', ...overrides
    };
}

test('SQLite stores, edits and soft-deletes an income with stable ID and versions', async (t) => {
    const { repository } = database(t);
    const added = await repository.addIncomeRecord(income());
    assert.equal(added.added, true);
    const original = await repository.getRecord(added.id);
    assert.equal(original.rowIndex, added.id + 1);
    assert.equal(original.amountGel, 270);
    assert.equal((await repository.getMonthlySummary(2026, 11)).totalIncomeGel, 270);
    await assert.rejects(repository.addIncomeRecord(income()), { code: 'INCOME_DUPLICATE' });
    const edited = await repository.updateIncomeRecord({
        id: added.id, expectedVersion: original.version,
        record: income({ amountOriginal: 120, amountGel: 324, taxGel: 3.24 })
    });
    assert.equal(edited.version, original.version + 1);
    assert.equal(edited.amountGel, 324);
    await assert.rejects(
        repository.deleteIncomeRecord({ id: added.id, expectedVersion: original.version }),
        { code: 'INCOME_VERSION_CONFLICT' }
    );
    await repository.deleteIncomeRecord({ id: added.id, expectedVersion: edited.version });
    assert.equal(await repository.getRecord(added.id), null);
    assert.equal((await repository.getMonthlySummary(2026, 11)).recordsCount, 0);
});

test('SQLite imports sheet rows and keeps reconciliation IDs stable', async (t) => {
    const { repository, dir } = database(t);
    const rows = [
        { rowIndex: 2, recordType: 'Доход', ...income({ date: '19.11.2026', paymentDate: '20.11.2026' }) },
        { rowIndex: 3, recordType: 'Платёж RS.GE', description: 'Несопоставленный платеж RS.GE',
            reconciliationStatus: 'Только в RS.GE', rsPaymentDate: '20.11.2026',
            rsPaymentAmount: 3, rsPaymentId: 'portal-1' }
    ];
    assert.deepEqual(await repository.importRecords(rows), { imported: 2 });
    const all = await repository.getAllRecords();
    assert.equal(all[0].date, '2026-11-19');
    assert.equal(all[0].rowIndex, 2);
    assert.equal(all[1].recordType, 'Платёж RS.GE');
    assert.equal(all[1].rsPaymentAmount, 3);
    assert.equal(migrationPlan(all).fingerprint, migrationPlan(rows).fingerprint);
    await assert.rejects(repository.importRecords(rows), { code: 'IMPORT_NONEMPTY_DB' });
    await repository.applyPaymentReconciliationPlan({
        updates: [{ rowIndex: 2, expectedVersion: all[0].version,
            reconciliationStatus: 'Совпадает', rsPaymentDate: '20.11.2026',
            rsPaymentAmount: 2.7, rsPaymentId: 'portal-2' }],
        inserts: []
    });
    assert.equal((await repository.getRecord(1)).rsPaymentId, 'portal-2');
    const backupPath = path.join(dir, 'backup.sqlite');
    await repository.backup(backupPath);
    assert.ok(fs.statSync(backupPath).size > 0);
    assert.equal(fs.existsSync(`${backupPath}-wal`), false);
    assert.equal(fs.existsSync(`${backupPath}-shm`), false);
});

test('daily SQLite backup is verified and not overwritten on a repeated run', async (t) => {
    const { repository, filePath } = database(t);
    await repository.addIncomeRecord(income());
    const date = new Date('2026-11-20T12:00:00+04:00');
    const first = await createDailySqliteBackup({ filePath, now: date });
    assert.equal(first.created, true);
    await repository.addIncomeRecord(income({ date: '2026-11-20' }));
    const second = await createDailySqliteBackup({ filePath, now: date });
    assert.equal(second.created, false);
    const copy = createSqliteIncomeRepository({ filePath: first.destination });
    try { assert.equal((await copy.getAllRecords()).length, 1); }
    finally { copy.close(); }
});
