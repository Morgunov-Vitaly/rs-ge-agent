const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('../../config');
const { parseRecordPeriod } = require('../../domain/dates');
const { RECORD_TYPES } = require('../../services/sheets');

function storageError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function cents(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || Math.abs(number) > 100_000_000) {
        throw storageError('Некорректная денежная сумма', 'INVALID_MONEY');
    }
    return Math.round((number + Number.EPSILON) * 100);
}

function amount(value) {
    return Number((Number(value || 0) / 100).toFixed(2));
}

function isoDate(value) {
    const parsed = parseRecordPeriod(value);
    if (!parsed) throw storageError('Некорректная дата дохода', 'INVALID_INCOME_DATE');
    return `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
}

function createSqliteIncomeRepository({ filePath = config.storage.sqlitePath, now = () => new Date() } = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const db = new Database(filePath);
    fs.chmodSync(filePath, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    const version = db.pragma('user_version', { simple: true });
    if (version > 1) throw storageError('База создана более новой версией приложения', 'DB_VERSION_TOO_NEW');
    if (version === 0) {
        db.transaction(() => {
            db.exec(`
            CREATE TABLE ledger_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK (kind IN ('income', 'portal_payment')),
                source TEXT NOT NULL DEFAULT 'manual',
                source_reference TEXT,
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                UNIQUE (source, source_reference)
            );
            CREATE TABLE income_entries (
                record_id INTEGER PRIMARY KEY REFERENCES ledger_records(id),
                date TEXT NOT NULL,
                amount_original_cents INTEGER NOT NULL CHECK (amount_original_cents >= 0),
                currency TEXT NOT NULL,
                rate TEXT NOT NULL,
                amount_gel_cents INTEGER NOT NULL CHECK (amount_gel_cents >= 0),
                tax_gel_cents INTEGER NOT NULL CHECK (tax_gel_cents >= 0),
                payment_date TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'Ожидает подачи'
            );
            CREATE TABLE reconciliation_results (
                record_id INTEGER PRIMARY KEY REFERENCES ledger_records(id),
                status TEXT NOT NULL DEFAULT '',
                rs_payment_date TEXT NOT NULL DEFAULT '',
                rs_posted_date TEXT NOT NULL DEFAULT '',
                rs_amount_cents INTEGER,
                rs_payment_id TEXT NOT NULL DEFAULT '',
                reconciled_at TEXT NOT NULL DEFAULT '',
                comment TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE portal_payments (
                record_id INTEGER PRIMARY KEY REFERENCES ledger_records(id),
                description TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT '',
                reconciliation_status TEXT NOT NULL DEFAULT '',
                rs_payment_date TEXT NOT NULL DEFAULT '',
                rs_posted_date TEXT NOT NULL DEFAULT '',
                rs_amount_cents INTEGER,
                rs_payment_id TEXT NOT NULL DEFAULT '',
                reconciled_at TEXT NOT NULL DEFAULT '',
                comment TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE ledger_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id INTEGER NOT NULL REFERENCES ledger_records(id),
                action TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX income_date_idx ON income_entries(date);
            CREATE INDEX ledger_active_idx ON ledger_records(deleted_at, kind);
        `);
            db.pragma('user_version = 1');
        })();
    }

    const selectRecords = db.prepare(`
        SELECT l.id, l.kind, l.source, l.source_reference, l.version, l.created_at, l.updated_at,
            i.date, i.amount_original_cents, i.currency, i.rate, i.amount_gel_cents,
            i.tax_gel_cents, i.payment_date, i.description AS income_description, i.status AS income_status,
            r.status AS reconciliation_status, r.rs_payment_date AS income_rs_payment_date,
            r.rs_posted_date AS income_rs_posted_date, r.rs_amount_cents AS income_rs_amount_cents,
            r.rs_payment_id AS income_rs_payment_id, r.reconciled_at AS income_reconciled_at,
            r.comment AS income_reconciliation_comment,
            p.description AS portal_description, p.status AS portal_status,
            p.reconciliation_status AS portal_reconciliation_status,
            p.rs_payment_date AS portal_rs_payment_date, p.rs_posted_date AS portal_rs_posted_date,
            p.rs_amount_cents AS portal_rs_amount_cents, p.rs_payment_id AS portal_rs_payment_id,
            p.reconciled_at AS portal_reconciled_at, p.comment AS portal_comment
        FROM ledger_records l
        LEFT JOIN income_entries i ON i.record_id = l.id
        LEFT JOIN reconciliation_results r ON r.record_id = l.id
        LEFT JOIN portal_payments p ON p.record_id = l.id
        WHERE l.deleted_at IS NULL ORDER BY l.id
    `);
    const findLedger = db.prepare('SELECT id, kind, version, deleted_at FROM ledger_records WHERE id = ?');
    const duplicate = db.prepare(`
        SELECT l.id FROM ledger_records l JOIN income_entries i ON i.record_id = l.id
        WHERE l.deleted_at IS NULL AND i.date = ? AND i.amount_original_cents = ?
            AND i.currency = ? AND l.id != ? LIMIT 1
    `);
    const insertLedger = db.prepare(`INSERT INTO ledger_records
        (id, kind, source, source_reference, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
    const insertIncome = db.prepare(`INSERT INTO income_entries
        (record_id, date, amount_original_cents, currency, rate, amount_gel_cents,
         tax_gel_cents, payment_date, description, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertReconciliation = db.prepare(`INSERT INTO reconciliation_results
        (record_id, status, rs_payment_date, rs_posted_date, rs_amount_cents,
         rs_payment_id, reconciled_at, comment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(record_id) DO UPDATE SET
            status=excluded.status, rs_payment_date=excluded.rs_payment_date,
            rs_posted_date=excluded.rs_posted_date, rs_amount_cents=excluded.rs_amount_cents,
            rs_payment_id=excluded.rs_payment_id, reconciled_at=excluded.reconciled_at,
            comment=excluded.comment`);
    const insertPortal = db.prepare(`INSERT INTO portal_payments
        (record_id, description, status, reconciliation_status, rs_payment_date,
         rs_posted_date, rs_amount_cents, rs_payment_id, reconciled_at, comment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertEvent = db.prepare(`INSERT INTO ledger_events
        (record_id, action, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?)`);

    function timestamp() { return now().toISOString(); }

    function toRecord(row) {
        const income = row.kind === 'income';
        return {
            id: row.id,
            rowIndex: row.id + 1,
            version: row.version,
            source: row.source,
            sourceReference: row.source_reference || '',
            recordType: income ? RECORD_TYPES.INCOME : RECORD_TYPES.RS_GE_PAYMENT,
            date: income ? row.date : '',
            amountOriginal: income ? amount(row.amount_original_cents) : 0,
            currency: income ? row.currency : '',
            rate: income ? Number(row.rate) : 0,
            amountGel: income ? amount(row.amount_gel_cents) : 0,
            taxGel: income ? amount(row.tax_gel_cents) : 0,
            paymentDate: income ? row.payment_date : '',
            description: income ? row.income_description : row.portal_description,
            status: income ? row.income_status : row.portal_status,
            reconciliationStatus: income ? row.reconciliation_status || '' : row.portal_reconciliation_status,
            rsPaymentDate: income ? row.income_rs_payment_date || '' : row.portal_rs_payment_date,
            rsPostedDate: income ? row.income_rs_posted_date || '' : row.portal_rs_posted_date,
            rsPaymentAmount: (income ? row.income_rs_amount_cents : row.portal_rs_amount_cents) === null
                ? null : amount(income ? row.income_rs_amount_cents : row.portal_rs_amount_cents),
            rsPaymentId: income ? row.income_rs_payment_id || '' : row.portal_rs_payment_id,
            reconciledAt: income ? row.income_reconciled_at || '' : row.portal_reconciled_at,
            reconciliationComment: income ? row.income_reconciliation_comment || '' : row.portal_comment
        };
    }

    function getAllRecordsSync() { return selectRecords.all().map(toRecord); }
    function getRecordSync(id) { return getAllRecordsSync().find((record) => record.id === Number(id)) || null; }

    function assertEditable(id, expectedVersion) {
        const ledger = findLedger.get(Number(id));
        if (!ledger || ledger.deleted_at || ledger.kind !== 'income') {
            throw storageError('Запись дохода не найдена', 'INCOME_NOT_FOUND');
        }
        if (ledger.version !== Number(expectedVersion)) {
            throw storageError('Запись изменилась после предпросмотра. Обновите журнал.', 'INCOME_VERSION_CONFLICT');
        }
        return ledger;
    }

    function assertUnique(record, exceptId = 0) {
        const found = duplicate.get(isoDate(record.date), cents(record.amountOriginal), record.currency.toUpperCase(), exceptId);
        if (found) throw storageError('Такая запись уже есть в журнале.', 'INCOME_DUPLICATE');
    }

    function writeIncome(id, record) {
        insertIncome.run(id, isoDate(record.date), cents(record.amountOriginal), record.currency.toUpperCase(),
            String(record.rate), cents(record.amountGel), cents(record.taxGel),
            record.paymentDate || '', record.description || '',
            record.status === undefined ? 'Ожидает подачи' : record.status);
    }

    const addIncome = db.transaction((record) => {
        assertUnique(record);
        const at = timestamp();
        const result = insertLedger.run(null, 'income', 'manual', null, at, at);
        const id = Number(result.lastInsertRowid);
        writeIncome(id, record);
        insertEvent.run(id, 'created', null, JSON.stringify(record), at);
        return { added: true, id, message: 'Доход записан в локальный журнал.' };
    });

    const updateIncome = db.transaction(({ id, expectedVersion, record }) => {
        assertEditable(id, expectedVersion);
        assertUnique(record, Number(id));
        const before = getRecordSync(id);
        db.prepare(`UPDATE income_entries SET date=?, amount_original_cents=?, currency=?, rate=?,
            amount_gel_cents=?, tax_gel_cents=?, payment_date=?, description=? WHERE record_id=?`)
            .run(isoDate(record.date), cents(record.amountOriginal), record.currency.toUpperCase(), String(record.rate),
                cents(record.amountGel), cents(record.taxGel), record.paymentDate || '', record.description || '', Number(id));
        const at = timestamp();
        db.prepare('UPDATE ledger_records SET version=version+1, updated_at=? WHERE id=?').run(at, Number(id));
        insertEvent.run(Number(id), 'updated', JSON.stringify(before), JSON.stringify(getRecordSync(id)), at);
        return getRecordSync(id);
    });

    const deleteIncome = db.transaction(({ id, expectedVersion }) => {
        assertEditable(id, expectedVersion);
        const before = getRecordSync(id);
        const at = timestamp();
        db.prepare('UPDATE ledger_records SET version=version+1, updated_at=?, deleted_at=? WHERE id=?')
            .run(at, at, Number(id));
        insertEvent.run(Number(id), 'deleted', JSON.stringify(before), null, at);
        return { deleted: true, record: before };
    });

    function setReconciliation(id, values) {
        insertReconciliation.run(id, values.reconciliationStatus || '', values.rsPaymentDate || '',
            values.rsPostedDate || '', values.rsPaymentAmount === null || values.rsPaymentAmount === undefined
                ? null : cents(values.rsPaymentAmount), values.rsPaymentId || '',
            values.reconciledAt || '', values.reconciliationComment || '');
    }

    const applyPlan = db.transaction((plan) => {
        const at = timestamp();
        for (const update of plan.updates) {
            const id = Number(update.rowIndex) - 1;
            const existing = findLedger.get(id);
            if (!existing || existing.kind !== 'income' || existing.deleted_at ||
                (update.expectedVersion !== undefined && existing.version !== update.expectedVersion)) {
                throw storageError('Журнал изменился после предпросмотра сверки.', 'RECONCILIATION_STALE');
            }
            const before = getRecordSync(id);
            setReconciliation(id, update);
            db.prepare('UPDATE ledger_records SET version=version+1, updated_at=? WHERE id=?').run(at, id);
            insertEvent.run(id, 'reconciled', JSON.stringify(before), JSON.stringify(getRecordSync(id)), at);
        }
        for (const insertion of plan.inserts) {
            const inserted = insertLedger.run(null, 'portal_payment', 'rs_ge', insertion.rsPaymentId || null, at, at);
            const id = Number(inserted.lastInsertRowid);
            insertPortal.run(id, insertion.description || 'Несопоставленный платеж RS.GE',
                '', insertion.reconciliationStatus || 'Только в RS.GE', insertion.rsPaymentDate || '',
                insertion.rsPostedDate || '', insertion.rsPaymentAmount === null || insertion.rsPaymentAmount === undefined
                    ? null : cents(insertion.rsPaymentAmount), insertion.rsPaymentId || '',
                insertion.reconciledAt || '', insertion.reconciliationComment || '');
            insertEvent.run(id, 'portal_payment_imported', null, JSON.stringify(insertion), at);
        }
        return { updatedRows: plan.updates.length, insertedRows: plan.inserts.length };
    });

    const importRows = db.transaction((records) => {
        if (db.prepare('SELECT COUNT(*) AS count FROM ledger_records').get().count) {
            throw storageError('База уже содержит записи. Импорт допускается только в пустую БД.', 'IMPORT_NONEMPTY_DB');
        }
        const at = timestamp();
        for (const record of records) {
            const id = Number(record.rowIndex) - 1;
            if (!Number.isSafeInteger(id) || id < 1) {
                throw storageError('В таблице обнаружен некорректный номер строки.', 'IMPORT_INVALID_ROW');
            }
            const income = !record.recordType || record.recordType === RECORD_TYPES.INCOME;
            insertLedger.run(id, income ? 'income' : 'portal_payment', 'google_sheets', String(record.rowIndex), at, at);
            if (income) {
                writeIncome(id, record);
                if (record.reconciliationStatus || record.rsPaymentId ||
                    (record.rsPaymentAmount !== null && record.rsPaymentAmount !== undefined)) {
                    setReconciliation(id, record);
                }
            } else {
                insertPortal.run(id, record.description || '', record.status || '',
                    record.reconciliationStatus || '', record.rsPaymentDate || '', record.rsPostedDate || '',
                    record.rsPaymentAmount === null || record.rsPaymentAmount === undefined
                        ? null : cents(record.rsPaymentAmount), record.rsPaymentId || '',
                    record.reconciledAt || '', record.reconciliationComment || '');
            }
            insertEvent.run(id, 'imported', null, JSON.stringify(record), at);
        }
        return { imported: records.length };
    });

    function monthlySummary(year, month) {
        const records = getAllRecordsSync().filter((record) => {
            const period = parseRecordPeriod(record.date);
            return record.recordType === RECORD_TYPES.INCOME && period?.year === year && period?.month === month;
        });
        const totalIncomeGel = amount(records.reduce((sum, record) => sum + cents(record.amountGel), 0));
        const totalTaxGel = amount(records.reduce((sum, record) => sum + cents(record.taxGel), 0));
        const statuses = [...new Set(records.map((record) => record.status.trim()).filter(Boolean))];
        const paymentDates = records.map((record) => record.paymentDate.trim()).filter(Boolean);
        const isFiled = records.length > 0 && records.every((record) =>
            ['подана', 'sent', 'გაგზავნილი'].includes(record.status.trim().toLocaleLowerCase('ru-RU')));
        return {
            year, month, recordsCount: records.length, records, totalIncomeGel, totalTaxGel,
            paymentDate: paymentDates.at(-1) || '', paymentDates,
            isPaid: paymentDates.length > 0, isFiled,
            status: records.length ? statuses.join(', ') || 'Ожидает подачи' : 'Нет записей'
        };
    }

    function yearlySummary(year, throughMonth = 12) {
        const records = getAllRecordsSync().filter((record) => {
            const period = parseRecordPeriod(record.date);
            return record.recordType === RECORD_TYPES.INCOME && period?.year === year && period.month <= throughMonth;
        });
        return {
            year, throughMonth, recordsCount: records.length, records,
            totalIncomeGel: amount(records.reduce((sum, record) => sum + cents(record.amountGel), 0)),
            totalTaxGel: amount(records.reduce((sum, record) => sum + cents(record.taxGel), 0))
        };
    }

    async function backup(destination) {
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        await db.backup(destination);
        fs.chmodSync(destination, 0o600);
        const proof = new Database(destination);
        try {
            proof.pragma('wal_checkpoint(TRUNCATE)');
            proof.pragma('journal_mode = DELETE');
            if (proof.pragma('integrity_check', { simple: true }) !== 'ok') {
                throw storageError('Резервная копия не прошла проверку целостности', 'BACKUP_INVALID');
            }
        } finally { proof.close(); }
        return destination;
    }

    return Object.freeze({
        driver: 'sqlite', filePath,
        getAllRecords: async () => getAllRecordsSync(),
        getIncomeRecords: async () => getAllRecordsSync().filter((record) => record.recordType === RECORD_TYPES.INCOME),
        getRecord: async (id) => getRecordSync(id),
        getMonthlySummary: async (year, month) => monthlySummary(year, month),
        getYearlySummary: async (year, throughMonth) => yearlySummary(year, throughMonth),
        addIncomeRecord: async (record) => addIncome(record),
        updateIncomeRecord: async (input) => updateIncome(input),
        deleteIncomeRecord: async (input) => deleteIncome(input),
        applyPaymentReconciliationPlan: async (plan) => applyPlan(plan),
        importRecords: async (records) => importRows(records),
        backup,
        close: () => db.close()
    });
}

module.exports = { createSqliteIncomeRepository, cents, amount };
