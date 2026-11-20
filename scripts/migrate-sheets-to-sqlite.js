const crypto = require('crypto');
const { config } = require('../config');
const { parseRecordPeriod } = require('../domain/dates');
const { createGoogleSheetsIncomeRepository } = require('../connectors/google-sheets/income-repository');
const { createSqliteIncomeRepository } = require('../connectors/sqlite/income-repository');

const FIELDS = Object.freeze([
    'rowIndex', 'recordType', 'date', 'amountOriginal', 'currency', 'rate',
    'amountGel', 'taxGel', 'paymentDate', 'description', 'status',
    'reconciliationStatus', 'rsPaymentDate', 'rsPostedDate',
    'rsPaymentAmount', 'rsPaymentId', 'reconciledAt', 'reconciliationComment'
]);
const MONEY_FIELDS = new Set(['amountOriginal', 'amountGel', 'taxGel', 'rsPaymentAmount']);

function normalized(record) {
    const result = {};
    for (const field of FIELDS) {
        let value = record[field];
        if (field === 'recordType') value = value || 'Доход';
        if (field === 'date' && value) {
            const date = parseRecordPeriod(value);
            if (!date) throw new Error(`Некорректная дата в строке ${record.rowIndex}`);
            value = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
        }
        if (MONEY_FIELDS.has(field)) {
            value = field === 'rsPaymentAmount' && (value === null || value === undefined)
                ? null : Number(Number(value || 0).toFixed(2));
        } else if (field === 'rate') {
            value = Number(value || 0);
        } else if (field === 'rowIndex') {
            value = Number(value);
        } else {
            value = String(value || '');
        }
        result[field] = value;
    }
    return result;
}

function migrationPlan(records) {
    const rows = records.map(normalized).sort((left, right) => left.rowIndex - right.rowIndex);
    const seen = new Set();
    const byPeriod = new Map();
    let incomeCount = 0;
    let portalPaymentCount = 0;
    for (const row of rows) {
        if (!Number.isSafeInteger(row.rowIndex) || row.rowIndex < 2 || seen.has(row.rowIndex)) {
            throw new Error(`Дублирующийся или некорректный номер строки: ${row.rowIndex}`);
        }
        seen.add(row.rowIndex);
        if (row.recordType === 'Доход') {
            if (!row.date || row.amountOriginal === null || row.amountOriginal < 0 || !row.currency) {
                throw new Error(`Неполная строка дохода ${row.rowIndex}. Исправьте ее до миграции.`);
            }
            incomeCount += 1;
            const key = row.date.slice(0, 7);
            const entry = byPeriod.get(key) || { period: key, count: 0, incomeGel: 0, taxGel: 0 };
            entry.count += 1;
            entry.incomeGel = Number((entry.incomeGel + row.amountGel).toFixed(2));
            entry.taxGel = Number((entry.taxGel + row.taxGel).toFixed(2));
            byPeriod.set(key, entry);
        } else if (row.recordType === 'Платёж RS.GE') {
            portalPaymentCount += 1;
        } else {
            throw new Error(`Неизвестный тип записи в строке ${row.rowIndex}`);
        }
    }
    return {
        fingerprint: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        rows, incomeCount, portalPaymentCount,
        periods: [...byPeriod.values()].sort((left, right) => left.period.localeCompare(right.period))
    };
}

async function runMigration({ sheetRepository = createGoogleSheetsIncomeRepository(),
    sqlitePath = config.storage.sqlitePath, apply = false, expectedFingerprint = '' } = {}) {
    const sourceRecords = await sheetRepository.getAllRecords();
    const source = migrationPlan(sourceRecords);
    const report = {
        mode: apply ? 'apply' : 'preview', sqlitePath, fingerprint: source.fingerprint,
        records: source.rows.length, incomes: source.incomeCount,
        portalPayments: source.portalPaymentCount, periods: source.periods
    };
    if (!apply) return report;
    if (!expectedFingerprint || expectedFingerprint !== source.fingerprint) {
        throw new Error('Отпечаток данных не совпал с предпросмотром. Повторите dry-run.');
    }
    const repository = createSqliteIncomeRepository({ filePath: sqlitePath });
    try {
        await repository.importRecords(sourceRecords);
        const destination = migrationPlan(await repository.getAllRecords());
        if (destination.fingerprint !== source.fingerprint) {
            throw new Error('Сверка после импорта не прошла. Не переключайте STORAGE_DRIVER.');
        }
        await repository.backup(`${sqlitePath}.before-cutover.backup`);
        return { ...report, verified: true, backup: `${sqlitePath}.before-cutover.backup` };
    } finally {
        repository.close();
    }
}

if (require.main === module) {
    const apply = process.argv.includes('--apply');
    const expectedFingerprint = process.argv.find((arg) => arg.startsWith('--fingerprint='))?.slice('--fingerprint='.length) || '';
    runMigration({ apply, expectedFingerprint })
        .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
        .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { migrationPlan, normalized, runMigration };
