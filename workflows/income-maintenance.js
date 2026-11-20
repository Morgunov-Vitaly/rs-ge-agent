const crypto = require('crypto');
const { ACTION_RISKS } = require('../core/action-contract');
const { parseRecordPeriod } = require('../domain/dates');
const { calculateSmallBusinessTax } = require('../domain/small-business');
const { auditLog: defaultAuditLog } = require('../infrastructure/audit-log');
const { validateIncomeInput } = require('./income-entry');

function maintenanceError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isFiled(status) {
    return /^(?:sent|подана|გაგზავნილი)$/i.test(String(status || '').trim());
}

function validatePaymentDate(value, now) {
    const text = String(value || '').trim();
    if (!text) return '';
    const parsed = parseRecordPeriod(text);
    const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now).map(({ type, value: part }) => [type, part]));
    const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
    if (!parsed) throw maintenanceError('Некорректная дата оплаты.', 'INVALID_PAYMENT_DATE');
    const result = `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
    if (result > today) throw maintenanceError('Дата оплаты не может быть в будущем.', 'INVALID_PAYMENT_DATE');
    return result;
}

function previewFingerprint(preview) {
    return crypto.createHash('sha256').update(JSON.stringify({
        action: preview.action, id: preview.id, version: preview.version,
        before: preview.before, after: preview.after, monthlyBefore: preview.monthlyBefore,
        monthlyAfter: preview.monthlyAfter, yearlyBefore: preview.yearlyBefore,
        yearlyAfter: preview.yearlyAfter
    })).digest('hex');
}

function idempotencyKey(preview) {
    return `ledger:${preview.id}:${preview.version}:${previewFingerprint(preview)}`;
}

async function contextForRecord({ recordsRepository, id }) {
    if (recordsRepository.driver !== 'sqlite' || typeof recordsRepository.getRecord !== 'function') {
        throw maintenanceError('Редактирование доступно после перехода на локальный журнал.', 'STORAGE_NOT_EDITABLE');
    }
    const record = await recordsRepository.getRecord(id);
    if (!record || record.recordType !== 'Доход') {
        throw maintenanceError('Запись дохода не найдена.', 'INCOME_NOT_FOUND');
    }
    const period = parseRecordPeriod(record.date);
    const all = await recordsRepository.getIncomeRecords();
    if (isFiled(record.status) || record.reconciliationStatus || record.rsPaymentId ||
        all.some((item) => {
            const itemPeriod = parseRecordPeriod(item.date);
            return itemPeriod?.year === period.year && itemPeriod.month >= period.month && isFiled(item.status);
        })) {
        throw maintenanceError(
            'Запись относится к поданному или сверенному периоду. Для исправления сначала нужна отдельная сверка с RS.GE.',
            'INCOME_PERIOD_LOCKED'
        );
    }
    const [monthSummary, yearSummary] = await Promise.all([
        recordsRepository.getMonthlySummary(period.year, period.month),
        recordsRepository.getYearlySummary(period.year, period.month)
    ]);
    const cumulativeBefore = Math.max(0, yearSummary.totalIncomeGel - monthSummary.totalIncomeGel);
    return { record, period, monthSummary, yearSummary, cumulativeBefore };
}

async function buildIncomeMaintenancePreview({ recordsRepository, id, intent, input = {}, convertToGel, now = new Date() }) {
    if (!['edit', 'delete'].includes(intent)) throw maintenanceError('Неизвестное действие.', 'INVALID_MAINTENANCE_ACTION');
    const context = await contextForRecord({ recordsRepository, id });
    const { record, period, monthSummary, yearSummary, cumulativeBefore } = context;
    let after = null;
    if (intent === 'edit') {
        const source = validateIncomeInput(input, now);
        const target = parseRecordPeriod(source.date);
        if (target.year !== period.year || target.month !== period.month) {
            throw maintenanceError('Перенос в другой месяц требует отдельного исправления периода.', 'INCOME_PERIOD_MOVE_BLOCKED');
        }
        const converted = await convertToGel(source.amount, source.currency, source.date);
        if (!Number.isFinite(converted.rate) || converted.rate <= 0 ||
            !Number.isFinite(converted.amountGel) || converted.amountGel <= 0) {
            throw maintenanceError('NBG вернул некорректный курс.', 'INVALID_NBG_RATE');
        }
        const paymentDate = validatePaymentDate(input.paymentDate, now);
        const newMonthIncome = Number((monthSummary.totalIncomeGel - record.amountGel + converted.amountGel).toFixed(2));
        const rateBefore = calculateSmallBusinessTax(monthSummary.totalIncomeGel, cumulativeBefore).rate;
        const rateAfter = calculateSmallBusinessTax(newMonthIncome, cumulativeBefore).rate;
        if (rateBefore !== rateAfter && monthSummary.recordsCount > 1) {
            throw maintenanceError('Исправление меняет ставку налога для других поступлений месяца. Нужна отдельная сверка.', 'INCOME_RATE_CHANGE_REQUIRES_REVIEW');
        }
        after = {
            date: source.date, amountOriginal: source.amount, currency: source.currency,
            rate: Number(converted.rate), amountGel: Number(converted.amountGel),
            taxGel: Math.round((converted.amountGel * rateAfter + Number.EPSILON) * 100) / 100,
            description: source.description, paymentDate, status: record.status
        };
    }
    const monthlyAfter = Number((monthSummary.totalIncomeGel - record.amountGel + (after?.amountGel || 0)).toFixed(2));
    const rateBefore = calculateSmallBusinessTax(monthSummary.totalIncomeGel, cumulativeBefore).rate;
    const rateAfter = calculateSmallBusinessTax(monthlyAfter, cumulativeBefore).rate;
    if (intent === 'delete' && rateBefore !== rateAfter && monthSummary.recordsCount > 1) {
        throw maintenanceError('Удаление меняет ставку налога для других поступлений месяца. Нужна отдельная сверка.', 'INCOME_RATE_CHANGE_REQUIRES_REVIEW');
    }
    return Object.freeze({
        action: intent === 'edit' ? 'small-business.edit-income' : 'small-business.delete-income',
        risk: ACTION_RISKS.DATA_WRITE,
        id: record.id, version: record.version,
        period: `${String(period.month).padStart(2, '0')}.${period.year}`,
        before: Object.freeze({
            date: record.date, amountOriginal: record.amountOriginal, currency: record.currency,
            rate: record.rate, amountGel: record.amountGel, taxGel: record.taxGel,
            description: record.description, paymentDate: record.paymentDate, status: record.status
        }),
        after: after ? Object.freeze(after) : null,
        monthlyBefore: monthSummary.totalIncomeGel, monthlyAfter,
        yearlyBefore: yearSummary.totalIncomeGel,
        yearlyAfter: Number((yearSummary.totalIncomeGel - record.amountGel + (after?.amountGel || 0)).toFixed(2))
    });
}

async function executeIncomeMaintenance(input, execution = {}) {
    const { recordsRepository, id, intent, rawInput, convertToGel, confirmedFingerprint,
        auditLog = defaultAuditLog, now = new Date() } = input;
    const action = intent === 'edit' ? 'small-business.edit-income' : 'small-business.delete-income';
    await auditLog.record({ action, risk: ACTION_RISKS.DATA_WRITE, status: 'started', metadata: { id } });
    try {
        const preview = await buildIncomeMaintenancePreview({
            recordsRepository, id, intent, input: rawInput, convertToGel, now
        });
        if (previewFingerprint(preview) !== confirmedFingerprint || execution.idempotencyKey !== idempotencyKey(preview)) {
            throw maintenanceError('Запись или расчет изменились после предпросмотра. Повторите действие.', 'INCOME_PREVIEW_STALE');
        }
        const result = intent === 'edit'
            ? await recordsRepository.updateIncomeRecord({ id, expectedVersion: preview.version, record: preview.after })
            : await recordsRepository.deleteIncomeRecord({ id, expectedVersion: preview.version });
        await auditLog.record({ action, risk: ACTION_RISKS.DATA_WRITE, status: 'completed', metadata: { id, period: preview.period } });
        return { preview, result };
    } catch (error) {
        await auditLog.record({ action, risk: ACTION_RISKS.DATA_WRITE, status: 'failed', metadata: { id, errorCode: error.code || 'UNKNOWN' } });
        throw error;
    }
}

module.exports = { buildIncomeMaintenancePreview, executeIncomeMaintenance, previewFingerprint, idempotencyKey };
