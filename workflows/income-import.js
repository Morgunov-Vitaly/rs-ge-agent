const crypto = require('crypto');
const { ACTION_RISKS } = require('../core/action-contract');
const { parseRecordPeriod, sameRecordDate } = require('../domain/dates');
const { auditLog: defaultAuditLog } = require('../infrastructure/audit-log');
const { buildIncomePreview } = require('./income-entry');

function importError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isFiled(record) {
    return /^(?:sent|подана|გაგზავნილი)$/i.test(String(record.status || '').trim());
}

function localToday(now) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function validatedPaymentDate(value, now) {
    if (!value) return '';
    const parsed = parseRecordPeriod(value);
    if (!parsed) throw importError('Некорректная дата оплаты.', 'IMPORT_PAYMENT_DATE');
    const date = `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
    if (date > localToday(now)) throw importError('Дата оплаты не может быть в будущем.', 'IMPORT_PAYMENT_DATE');
    return date;
}

function snapshot(records) {
    return records.map((record) => ({
        id: record.id || record.rowIndex || 0, version: record.version || 0,
        recordType: record.recordType || 'Доход', date: record.date || '',
        amountOriginal: record.amountOriginal || 0, currency: record.currency || '',
        amountGel: record.amountGel || 0, taxGel: record.taxGel || 0,
        status: record.status || '', paymentDate: record.paymentDate || '',
        reconciliationStatus: record.reconciliationStatus || '', rsPaymentId: record.rsPaymentId || ''
    }));
}

function virtualRepository(records) {
    function incomes() { return records.filter((record) => !record.recordType || record.recordType === 'Доход'); }
    return {
        getAllRecords: async () => records,
        getMonthlySummary: async (year, month) => {
            const selected = incomes().filter((record) => {
                const period = parseRecordPeriod(record.date);
                return period?.year === year && period.month === month;
            });
            return {
                recordsCount: selected.length,
                totalIncomeGel: Number(selected.reduce((sum, record) => sum + Number(record.amountGel || 0), 0).toFixed(2)),
                totalTaxGel: Number(selected.reduce((sum, record) => sum + Number(record.taxGel || 0), 0).toFixed(2)),
                isFiled: selected.length > 0 && selected.every(isFiled)
            };
        },
        getYearlySummary: async (year, month) => ({
            totalIncomeGel: Number(incomes().filter((record) => {
                const period = parseRecordPeriod(record.date);
                return period?.year === year && period.month <= month;
            }).reduce((sum, record) => sum + Number(record.amountGel || 0), 0).toFixed(2))
        })
    };
}

function importFingerprint(preview) {
    return crypto.createHash('sha256').update(JSON.stringify({
        action: preview.action, original: preview.original, input: preview.input,
        importable: preview.importable, duplicates: preview.duplicates, errors: preview.errors
    })).digest('hex');
}

function importIdempotencyKey(preview) { return `income-import:${importFingerprint(preview)}`; }

async function buildIncomeImportPreview({ parsed, recordsRepository, convertToGel, now = new Date() }) {
    if (recordsRepository.driver !== 'sqlite' || typeof recordsRepository.addIncomeRecords !== 'function') {
        throw importError('Импорт доступен только для локального журнала SQLite.', 'IMPORT_STORAGE_UNAVAILABLE');
    }
    const existing = await recordsRepository.getAllRecords();
    const original = snapshot(existing);
    const staged = [...existing];
    const virtual = virtualRepository(staged);
    const cache = new Map();
    const importable = [];
    const duplicates = [];
    const errors = [];
    for (const item of parsed.items) {
        try {
            const duplicate = staged.some((record) =>
                (!record.recordType || record.recordType === 'Доход') &&
                sameRecordDate(record.date, item.input.date) &&
                String(record.currency || '').toUpperCase() === String(item.input.currency || '').toUpperCase() &&
                Math.abs(Number(record.amountOriginal) - Number(String(item.input.amount || '').replace(',', '.'))) < 0.001);
            if (duplicate) {
                duplicates.push({ line: item.line, reason: 'Уже есть в журнале или в этом файле' });
                continue;
            }
            const period = parseRecordPeriod(item.input.date);
            if (period && staged.some((record) => {
                const later = parseRecordPeriod(record.date);
                return later?.year === period.year && ((later.month >= period.month && isFiled(record)) ||
                    (later.month === period.month && Boolean(record.reconciliationStatus || record.rsPaymentId)));
            })) {
                throw importError('Этот или более поздний период года уже отмечен как поданный.', 'IMPORT_PERIOD_LOCKED');
            }
            const paymentDate = validatedPaymentDate(item.input.paymentDate, now);
            const cachedConversion = async (amount, currency, date) => {
                const key = `${date}:${currency}`;
                if (!cache.has(key)) {
                    if (cache.size >= 100) throw importError('В одном файле допускается не более 100 разных дат и валют.', 'IMPORT_TOO_MANY_RATES');
                    cache.set(key, await convertToGel(1, currency, date));
                }
                const base = cache.get(key);
                return { ...base, rate: Number(base.rate), amountGel: Number((amount * Number(base.rate)).toFixed(2)) };
            };
            const preview = await buildIncomePreview({ input: item.input,
                convertToGel: cachedConversion, recordsRepository: virtual, now });
            const record = { ...preview.record, paymentDate };
            staged.push(record);
            importable.push({ line: item.line, record });
        } catch (error) {
            if (error.code === 'INCOME_DUPLICATE') duplicates.push({ line: item.line, reason: 'Уже есть в журнале или в этом файле' });
            else errors.push({ line: item.line,
                reason: error.code ? error.message : 'Не удалось проверить курс NBG. Повторите позже.' });
        }
    }
    return Object.freeze({
        action: 'small-business.import-income', risk: ACTION_RISKS.DATA_WRITE,
        original, input: parsed.items, importable, duplicates, errors,
        portalRows: parsed.portalRows,
        totalIncomeGel: Number(importable.reduce((sum, item) => sum + item.record.amountGel, 0).toFixed(2)),
        totalTaxGel: Number(importable.reduce((sum, item) => sum + item.record.taxGel, 0).toFixed(2))
    });
}

async function executeIncomeImport(input, execution = {}) {
    const { parsed, recordsRepository, convertToGel, confirmedFingerprint,
        auditLog = defaultAuditLog, now = new Date() } = input;
    await auditLog.record({ action: 'small-business.import-income', risk: ACTION_RISKS.DATA_WRITE, status: 'started' });
    try {
        const preview = await buildIncomeImportPreview({ parsed, recordsRepository, convertToGel, now });
        if (importFingerprint(preview) !== confirmedFingerprint || execution.idempotencyKey !== importIdempotencyKey(preview)) {
            throw importError('Журнал или курс изменились после предпросмотра. Загрузите файл заново.', 'IMPORT_PREVIEW_STALE');
        }
        if (preview.errors.length || !preview.importable.length) {
            throw importError('Нет записей для импорта или файл содержит ошибки.', 'IMPORT_NOT_READY');
        }
        const result = await recordsRepository.addIncomeRecords(preview.importable.map(({ record }) => record));
        await auditLog.record({ action: 'small-business.import-income', risk: ACTION_RISKS.DATA_WRITE,
            status: 'completed', metadata: { imported: result.imported } });
        return { preview, result };
    } catch (error) {
        await auditLog.record({ action: 'small-business.import-income', risk: ACTION_RISKS.DATA_WRITE,
            status: 'failed', metadata: { errorCode: error.code || 'UNKNOWN' } });
        throw error;
    }
}

module.exports = { buildIncomeImportPreview, executeIncomeImport, importFingerprint, importIdempotencyKey };
