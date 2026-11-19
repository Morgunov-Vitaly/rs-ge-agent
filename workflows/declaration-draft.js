const crypto = require('crypto');
const { ACTION_RISKS } = require('../core/action-contract');
const { calculateSmallBusinessTax } = require('../domain/small-business');
const { auditLog: defaultAuditLog } = require('../infrastructure/audit-log');

const DECLARATION_ACTION = 'small-business.create-declaration-draft';
const COMPARED_FIELDS = Object.freeze([15, 16, 17, 18, 19, 20, 21, 26]);

function workflowError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function money(value, name) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw workflowError(`Некорректное значение ${name}`, 'INVALID_DECLARATION_DATA');
    }
    return Number(parsed.toFixed(2));
}

function buildDeclarationDraftPreview({ year, month, summary, yearSummary }) {
    if (!Number.isInteger(year) || year < 2016 || !Number.isInteger(month) || month < 1 || month > 12) {
        throw workflowError('Некорректный отчетный период', 'INVALID_DECLARATION_PERIOD');
    }
    if (!summary || !yearSummary) {
        throw workflowError('Для preview нужны месячная и годовая сводки', 'INVALID_DECLARATION_DATA');
    }
    if (summary.isFiled) {
        throw workflowError(
            `В Google Sheets декларация за ${String(month).padStart(2, '0')}.${year} уже отмечена как поданная.`,
            'DECLARATION_ALREADY_FILED'
        );
    }

    const monthlyIncomeGel = money(summary.totalIncomeGel, 'дохода за месяц');
    const cumulativeIncomeGel = money(yearSummary.totalIncomeGel, 'нарастающего дохода');
    const cumulativeBeforeMonth = Number((cumulativeIncomeGel - monthlyIncomeGel).toFixed(2));
    if (cumulativeBeforeMonth < -0.02) {
        throw workflowError(
            'Месячный доход превышает годовой нарастающий итог',
            'INVALID_DECLARATION_DATA'
        );
    }

    const tax = calculateSmallBusinessTax(monthlyIncomeGel, Math.max(0, cumulativeBeforeMonth));
    const sheetTaxGel = money(summary.totalTaxGel || 0, 'налога в таблице');
    const fields = Object.freeze({
        15: cumulativeIncomeGel,
        16: Number((tax.rate * 100).toFixed(2)),
        17: monthlyIncomeGel,
        18: 0,
        19: 0,
        20: monthlyIncomeGel,
        21: 0,
        26: tax.taxAmount
    });
    const warnings = [];
    if (Math.abs(sheetTaxGel - tax.taxAmount) > 0.02) {
        warnings.push(
            `Налог в таблице (${sheetTaxGel.toFixed(2)} GEL) отличается от расчета по годовому лимиту ` +
            `(${tax.taxAmount.toFixed(2)} GEL). В черновик попадет расчет по ставке ${fields[16].toFixed(0)}%.`
        );
    }

    return Object.freeze({
        action: DECLARATION_ACTION,
        risk: ACTION_RISKS.DRAFT_WRITE,
        year,
        month,
        period: `${String(month).padStart(2, '0')}.${year}`,
        fields,
        source: Object.freeze({
            recordsCount: Number(summary.recordsCount || 0),
            sheetTaxGel
        }),
        warnings: Object.freeze(warnings)
    });
}

function getDeclarationPreviewFingerprint(preview) {
    const payload = JSON.stringify({
        action: preview.action,
        year: preview.year,
        month: preview.month,
        fields: COMPARED_FIELDS.map((field) => [field, preview.fields[field]])
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function createDraftIdempotencyKey(preview) {
    return `small-business:${preview.year}-${String(preview.month).padStart(2, '0')}:` +
        getDeclarationPreviewFingerprint(preview).slice(0, 20);
}

function declarationFieldsMatch(actualFields, expectedFields, tolerance = 0.02) {
    return COMPARED_FIELDS.every((field) => (
        Number.isFinite(Number(actualFields?.[field])) &&
        Math.abs(Number(actualFields[field]) - Number(expectedFields[field])) <= tolerance
    ));
}

function isSentStatus(status) {
    return /sent|подан|გაგზავნილ|გადაგზავნილ/i.test(String(status || ''));
}

async function executeDeclarationDraftCreation(input, execution = {}) {
    const {
        recordsRepository,
        rsGeClient,
        year,
        month,
        previewFingerprint,
        auditLog = defaultAuditLog
    } = input || {};
    const startedAt = Date.now();
    const idempotencyKey = execution.idempotencyKey || '';

    await auditLog.record({
        action: DECLARATION_ACTION,
        risk: ACTION_RISKS.DRAFT_WRITE,
        status: 'started',
        metadata: { year, month, idempotencyKey }
    });

    try {
        const [summary, yearSummary] = await Promise.all([
            recordsRepository.getMonthlySummary(year, month),
            recordsRepository.getYearlySummary(year, month)
        ]);
        const preview = buildDeclarationDraftPreview({ year, month, summary, yearSummary });
        const currentFingerprint = getDeclarationPreviewFingerprint(preview);
        if (!previewFingerprint || currentFingerprint !== previewFingerprint) {
            throw workflowError(
                'Данные Google Sheets изменились после preview. Запустите /fill заново и подтвердите новые суммы.',
                'DECLARATION_PREVIEW_STALE'
            );
        }
        if (idempotencyKey !== createDraftIdempotencyKey(preview)) {
            throw workflowError(
                'Ключ операции не соответствует подтвержденному preview.',
                'IDEMPOTENCY_KEY_MISMATCH'
            );
        }

        const existing = await rsGeClient.openExistingSmallBusinessDraft(year, month);
        if (existing.exists) {
            if (isSentStatus(existing.status)) {
                throw workflowError(
                    `Декларация за ${preview.period} уже отправлена на RS.GE.`,
                    'DECLARATION_ALREADY_SENT'
                );
            }
            if (!declarationFieldsMatch(existing.fields, preview.fields)) {
                throw workflowError(
                    `На RS.GE уже существует черновик за ${preview.period} с другими значениями.`,
                    'DECLARATION_DRAFT_CONFLICT'
                );
            }

            await auditLog.record({
                action: DECLARATION_ACTION,
                risk: ACTION_RISKS.DRAFT_WRITE,
                status: 'idempotent-replay',
                durationMs: Date.now() - startedAt,
                metadata: { year, month, idempotencyKey }
            });
            return { created: false, alreadyExists: true, preview, draft: existing };
        }

        const draft = await rsGeClient.createSmallBusinessDraft(preview, { idempotencyKey });
        if (!draft?.exists || isSentStatus(draft.status)) {
            throw workflowError(
                'RS.GE не подтвердил сохранение черновика.',
                'DECLARATION_DRAFT_NOT_SAVED'
            );
        }
        if (!declarationFieldsMatch(draft.fields, preview.fields)) {
            throw workflowError(
                'Сохраненный черновик отличается от подтвержденного preview.',
                'DECLARATION_DRAFT_VERIFICATION_FAILED'
            );
        }

        await auditLog.record({
            action: DECLARATION_ACTION,
            risk: ACTION_RISKS.DRAFT_WRITE,
            status: 'completed',
            durationMs: Date.now() - startedAt,
            metadata: {
                year,
                month,
                idempotencyKey,
                incomeGel: preview.fields[20],
                cumulativeIncomeGel: preview.fields[15],
                taxGel: preview.fields[26]
            }
        });
        return { created: true, alreadyExists: false, preview, draft };
    } catch (error) {
        await auditLog.record({
            action: DECLARATION_ACTION,
            risk: ACTION_RISKS.DRAFT_WRITE,
            status: 'failed',
            durationMs: Date.now() - startedAt,
            metadata: {
                year,
                month,
                idempotencyKey,
                errorCode: error.code || 'UNKNOWN',
                errorName: error.name
            }
        });
        throw error;
    }
}

module.exports = {
    DECLARATION_ACTION,
    COMPARED_FIELDS,
    buildDeclarationDraftPreview,
    getDeclarationPreviewFingerprint,
    createDraftIdempotencyKey,
    declarationFieldsMatch,
    isSentStatus,
    executeDeclarationDraftCreation
};
