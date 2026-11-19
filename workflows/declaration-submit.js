const crypto = require('crypto');
const { config: defaultConfig } = require('../config');
const { ACTION_RISKS } = require('../core/action-contract');
const { auditLog: defaultAuditLog } = require('../infrastructure/audit-log');
const { evidenceStore: defaultEvidenceStore } = require('../infrastructure/evidence-store');
const {
    buildDeclarationDraftPreview,
    declarationFieldsMatch,
    isSentStatus
} = require('./declaration-draft');

const SUBMIT_DECLARATION_ACTION = 'small-business.submit-declaration';

function workflowError(message, code, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
}

function createPreview({ year, month, expectedDraft, draft }) {
    if (!draft?.exists) {
        throw workflowError(
            `На RS.GE нет сохраненного черновика за ${expectedDraft.period}.`,
            'DECLARATION_DRAFT_NOT_FOUND'
        );
    }
    if (!declarationFieldsMatch(draft.fields, expectedDraft.fields)) {
        throw workflowError(
            'Черновик RS.GE отличается от Google Sheets. Отправка заблокирована.',
            'DECLARATION_DRAFT_CONFLICT'
        );
    }

    return Object.freeze({
        action: SUBMIT_DECLARATION_ACTION,
        risk: ACTION_RISKS.IRREVERSIBLE,
        year,
        month,
        period: expectedDraft.period,
        fields: expectedDraft.fields,
        sourceStatus: draft.status || 'Неизвестен'
    });
}

function buildDeclarationSubmissionPreview({ year, month, summary, yearSummary, draft }) {
    const expectedDraft = buildDeclarationDraftPreview({ year, month, summary, yearSummary });
    if (isSentStatus(draft?.status)) {
        throw workflowError(
            `Декларация за ${expectedDraft.period} уже отправлена на RS.GE.`,
            'DECLARATION_ALREADY_SENT'
        );
    }
    return createPreview({ year, month, expectedDraft, draft });
}

function getSubmissionPreviewFingerprint(preview) {
    const payload = JSON.stringify({
        action: preview.action,
        year: preview.year,
        month: preview.month,
        fields: Object.entries(preview.fields).sort(([left], [right]) => Number(left) - Number(right))
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function createSubmissionIdempotencyKey(preview) {
    return `small-business:submit:${preview.year}-${String(preview.month).padStart(2, '0')}:` +
        getSubmissionPreviewFingerprint(preview).slice(0, 20);
}

async function executeDeclarationSubmission(input, execution = {}) {
    const {
        recordsRepository,
        rsGeClient,
        year,
        month,
        previewFingerprint,
        auditLog = defaultAuditLog,
        evidenceStore = defaultEvidenceStore,
        submissionEnabled = defaultConfig.rsGe.enableSubmission
    } = input || {};
    const startedAt = Date.now();
    const idempotencyKey = execution.idempotencyKey || '';

    await auditLog.record({
        action: SUBMIT_DECLARATION_ACTION,
        risk: ACTION_RISKS.IRREVERSIBLE,
        status: 'started',
        metadata: { year, month, idempotencyKey }
    });

    try {
        if (!submissionEnabled) {
            throw workflowError(
                'Финальная отправка отключена. Для live smoke нужно явно включить RSGE_ENABLE_SUBMISSION.',
                'SUBMISSION_DISABLED'
            );
        }
        if (typeof evidenceStore.assertReady === 'function') {
            await evidenceStore.assertReady();
        }

        const [summary, yearSummary] = await Promise.all([
            recordsRepository.getMonthlySummary(year, month),
            recordsRepository.getYearlySummary(year, month)
        ]);
        const expectedDraft = buildDeclarationDraftPreview({ year, month, summary, yearSummary });
        const existing = await rsGeClient.openExistingSmallBusinessDraft(year, month);
        const preview = createPreview({ year, month, expectedDraft, draft: existing });
        const currentFingerprint = getSubmissionPreviewFingerprint(preview);

        if (!previewFingerprint || previewFingerprint !== currentFingerprint) {
            throw workflowError(
                'Данные изменились после preview. Повторите /submit и проверьте новые суммы.',
                'DECLARATION_SUBMISSION_PREVIEW_STALE'
            );
        }
        if (idempotencyKey !== createSubmissionIdempotencyKey(preview)) {
            throw workflowError(
                'Ключ операции не соответствует подтвержденному preview.',
                'IDEMPOTENCY_KEY_MISMATCH'
            );
        }

        if (isSentStatus(existing.status)) {
            await auditLog.record({
                action: SUBMIT_DECLARATION_ACTION,
                risk: ACTION_RISKS.IRREVERSIBLE,
                status: 'idempotent-replay',
                durationMs: Date.now() - startedAt,
                metadata: { year, month, idempotencyKey }
            });
            return { submitted: false, alreadySent: true, preview, declaration: existing };
        }

        const declaration = await rsGeClient.submitSmallBusinessDeclaration(preview, {
            idempotencyKey
        });
        if (!declaration?.exists || !isSentStatus(declaration.status)) {
            throw workflowError(
                'Результат отправки неопределен. Не повторяйте операцию; сначала выполните read-only проверку.',
                'RSGE_SUBMISSION_OUTCOME_UNKNOWN'
            );
        }
        if (!declarationFieldsMatch(declaration.fields, preview.fields)) {
            throw workflowError(
                'Декларация получила Sent, но ее суммы отличаются от preview. Не повторяйте отправку; требуется ручная проверка.',
                'SUBMISSION_SUCCEEDED_VERIFICATION_FAILED'
            );
        }

        let evidence;
        try {
            evidence = await evidenceStore.saveDeclarationSubmission({
                year,
                month,
                screenshotBuffer: declaration.screenshotBuffer,
                pdfBuffer: declaration.pdfBuffer
            });
        } catch (cause) {
            throw workflowError(
                'Декларация отправлена, но evidence artifacts не сохранились. Не повторяйте отправку.',
                'SUBMISSION_SUCCEEDED_EVIDENCE_FAILED',
                cause
            );
        }

        try {
            await auditLog.record({
                action: SUBMIT_DECLARATION_ACTION,
                risk: ACTION_RISKS.IRREVERSIBLE,
                status: 'completed',
                durationMs: Date.now() - startedAt,
                metadata: {
                    year,
                    month,
                    idempotencyKey,
                    incomeGel: preview.fields[20],
                    taxGel: preview.fields[26],
                    evidence: evidence.artifacts.map(({ type, fileName, sha256, bytes }) => ({
                        type,
                        fileName,
                        sha256,
                        bytes
                    }))
                }
            });
        } catch (cause) {
            throw workflowError(
                'Декларация отправлена и evidence сохранены, но финальная audit-запись не создана. Не повторяйте отправку.',
                'SUBMISSION_SUCCEEDED_AUDIT_FAILED',
                cause
            );
        }
        return { submitted: true, alreadySent: false, preview, declaration, evidence };
    } catch (error) {
        const status = error.code === 'RSGE_SUBMISSION_OUTCOME_UNKNOWN'
            ? 'outcome-unknown'
            : (error.code === 'SUBMISSION_SUCCEEDED_VERIFICATION_FAILED'
                ? 'completed-verification-failed'
                : (error.code === 'SUBMISSION_SUCCEEDED_EVIDENCE_FAILED'
                    ? 'completed-evidence-failed'
                    : (error.code === 'SUBMISSION_SUCCEEDED_AUDIT_FAILED'
                        ? 'completed-audit-failed'
                        : (error.code === 'SUBMISSION_DISABLED' ? 'blocked' : 'failed'))));
        try {
            await auditLog.record({
                action: SUBMIT_DECLARATION_ACTION,
                risk: ACTION_RISKS.IRREVERSIBLE,
                status,
                durationMs: Date.now() - startedAt,
                metadata: {
                    year,
                    month,
                    idempotencyKey,
                    errorCode: error.code || 'UNKNOWN',
                    errorName: error.name
                }
            });
        } catch (auditFailure) {
            error.auditFailure = auditFailure.code || auditFailure.name || 'AUDIT_WRITE_FAILED';
        }
        throw error;
    }
}

module.exports = {
    SUBMIT_DECLARATION_ACTION,
    buildDeclarationSubmissionPreview,
    createSubmissionIdempotencyKey,
    executeDeclarationSubmission,
    getSubmissionPreviewFingerprint
};
