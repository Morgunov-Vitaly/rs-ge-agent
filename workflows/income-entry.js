const crypto = require('crypto');
const { ACTION_RISKS } = require('../core/action-contract');
const { parseRecordPeriod, sameRecordDate } = require('../domain/dates');
const { calculateSmallBusinessTax } = require('../domain/small-business');
const { auditLog: defaultAuditLog } = require('../infrastructure/audit-log');

function incomeError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function validateIncomeInput(input, now = new Date()) {
    const amount = Number(String(input.amount || '').replace(',', '.'));
    const date = String(input.date || '').trim();
    const currency = String(input.currency || '').trim().toUpperCase();
    const description = String(input.description || '').trim();
    const parsed = parseRecordPeriod(date);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000 || !/^\d+(?:[.,]\d{1,2})?$/.test(String(input.amount || ''))) {
        throw incomeError('Укажите положительную сумму с точностью до двух знаков.', 'INVALID_INCOME_AMOUNT');
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
        throw incomeError('Укажите трехбуквенный код валюты.', 'INVALID_INCOME_CURRENCY');
    }
    const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now).map(({ type, value }) => [type, value]));
    const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    if (!parsed || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
        throw incomeError('Укажите дату фактического поступления в формате ГГГГ-ММ-ДД, не позднее сегодняшнего дня.', 'INVALID_INCOME_DATE');
    }
    if (!description || description.length > 200) {
        throw incomeError('Укажите источник дохода длиной до 200 символов.', 'INVALID_INCOME_DESCRIPTION');
    }
    return { amount, currency, date, description };
}

async function buildIncomePreview({ input, convertToGel, recordsRepository, now = new Date() }) {
    const source = validateIncomeInput(input, now);
    const converted = await convertToGel(source.amount, source.currency, source.date);
    if (!Number.isFinite(converted.rate) || converted.rate <= 0 || !Number.isFinite(converted.amountGel) || converted.amountGel <= 0) {
        throw incomeError('NBG вернул некорректный курс или результат конвертации.', 'INVALID_NBG_RATE');
    }
    const records = await recordsRepository.getAllRecords();
    const duplicate = records.some((record) => (
        (!record.recordType || record.recordType === 'Доход') &&
        sameRecordDate(record.date, source.date) &&
        String(record.currency || '').toUpperCase() === source.currency &&
        Math.abs(record.amountOriginal - source.amount) < 0.001
    ));
    if (duplicate) throw incomeError('Такая запись уже есть в Google Sheets.', 'INCOME_DUPLICATE');

    const period = parseRecordPeriod(source.date);
    const yearSummary = await recordsRepository.getYearlySummary(period.year, period.month);
    const monthlySummary = await recordsRepository.getMonthlySummary(period.year, period.month);
    if (monthlySummary.isFiled) {
        throw incomeError('Декларация за этот месяц уже отмечена как поданная. Сначала проверьте период и внесите исправление вручную.', 'INCOME_PERIOD_ALREADY_FILED');
    }
    const beforeMonth = Math.max(0, yearSummary.totalIncomeGel - monthlySummary.totalIncomeGel);
    const estimatedMonthlyTax = calculateSmallBusinessTax(
        Number(monthlySummary.totalIncomeGel || 0) + converted.amountGel,
        beforeMonth
    );
    const existingRate = monthlySummary.totalIncomeGel > 0
        ? calculateSmallBusinessTax(monthlySummary.totalIncomeGel, beforeMonth).rate
        : estimatedMonthlyTax.rate;
    if (existingRate !== estimatedMonthlyTax.rate) {
        throw incomeError(
            'Новая запись меняет ставку налога для всего месяца. Нужна отдельная сверка уже записанных сумм.',
            'INCOME_RATE_CHANGE_REQUIRES_REVIEW'
        );
    }
    const tax = calculateSmallBusinessTax(converted.amountGel, beforeMonth);
    const record = {
        date: source.date,
        amountOriginal: source.amount,
        currency: source.currency,
        rate: Number(converted.rate),
        amountGel: Number(converted.amountGel),
        taxGel: tax.taxAmount,
        description: source.description,
        status: 'Ожидает подачи'
    };
    return Object.freeze({
        action: 'small-business.add-income',
        risk: ACTION_RISKS.DATA_WRITE,
        record: Object.freeze(record),
        period: `${String(period.month).padStart(2, '0')}.${period.year}`,
        ratePercent: Number((estimatedMonthlyTax.rate * 100).toFixed(2)),
        estimatedMonthlyTaxGel: estimatedMonthlyTax.taxAmount
    });
}

function incomeFingerprint(preview) {
    return crypto.createHash('sha256').update(JSON.stringify({
        action: preview.action,
        record: preview.record,
        ratePercent: preview.ratePercent,
        estimatedMonthlyTaxGel: preview.estimatedMonthlyTaxGel
    })).digest('hex');
}

function incomeIdempotencyKey(preview) {
    return `income:${incomeFingerprint(preview)}`;
}

async function executeIncomeEntry(input, execution = {}) {
    const { recordsRepository, convertToGel, rawInput, previewFingerprint, auditLog = defaultAuditLog, now = new Date() } = input;
    await auditLog.record({ action: 'small-business.add-income', risk: ACTION_RISKS.DATA_WRITE, status: 'started' });
    try {
        const preview = await buildIncomePreview({ input: rawInput, convertToGel, recordsRepository, now });
        if (incomeFingerprint(preview) !== previewFingerprint || execution.idempotencyKey !== incomeIdempotencyKey(preview)) {
            throw incomeError('Данные или курс изменились после preview. Проверьте новую сумму перед записью.', 'INCOME_PREVIEW_STALE');
        }
        const result = await recordsRepository.addIncomeRecord(preview.record);
        if (!result.added) throw incomeError(result.message || 'Запись уже существует.', 'INCOME_DUPLICATE');
        await auditLog.record({ action: 'small-business.add-income', risk: ACTION_RISKS.DATA_WRITE, status: 'completed', metadata: { period: preview.period } });
        return { preview, added: true };
    } catch (error) {
        await auditLog.record({ action: 'small-business.add-income', risk: ACTION_RISKS.DATA_WRITE, status: 'failed', metadata: { errorCode: error.code || 'UNKNOWN' } });
        throw error;
    }
}

module.exports = { buildIncomePreview, executeIncomeEntry, incomeFingerprint, incomeIdempotencyKey, validateIncomeInput };
