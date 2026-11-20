const crypto = require('crypto');
const { executeModuleAction } = require('../core/action-contract');
const smallBusinessModule = require('../modules/small-business/manifest');
const { executeDeclarationReview } = require('../workflows/declaration-review');
const { buildDeclarationDraftPreview, getDeclarationPreviewFingerprint, createDraftIdempotencyKey } = require('../workflows/declaration-draft');
const { buildDeclarationSubmissionPreview, getSubmissionPreviewFingerprint, createSubmissionIdempotencyKey } = require('../workflows/declaration-submit');

const ACTIVE_STATUSES = new Set(['starting', 'awaiting_sms', 'checking', 'awaiting_confirmation', 'writing']);

function publicOperation(operation) {
    return {
        id: operation.id,
        kind: operation.kind,
        status: operation.status,
        year: operation.year,
        month: operation.month,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
        preview: operation.preview || null,
        hasPreviewImage: Buffer.isBuffer(operation.previewImage),
        hasResultImage: Buffer.isBuffer(operation.resultImage),
        result: operation.result || null,
        error: operation.error || null
    };
}

function buildAccountCheckView(result) {
    return {
        period: result.period,
        verdict: result.verdict,
        report: result.report,
        incomeGel: Number(result.summary.totalIncomeGel || 0),
        taxGel: Number(result.summary.totalTaxGel || 0),
        sheetStatus: result.summary.status || 'Не указан',
        declaration: {
            exists: Boolean(result.declaration.exists),
            status: result.declaration.status || 'Не найдена',
            submittedAt: result.declaration.metadata?.submittedAt || '',
            registrationNumber: result.declaration.metadata?.registrationNumber || ''
        },
        balance: result.portalHistory.balance
            ? {
                debt: Number(result.portalHistory.balance.debt || 0),
                overpayment: Number(result.portalHistory.balance.overpayment || 0)
            }
            : null,
        paymentSatisfied: Boolean(result.paymentSatisfied),
        debtClear: Boolean(result.debtClear),
        issueCount: Number(result.issueCount || 0),
        counts: result.counts,
        needsReconciliation: Boolean(result.needsReconciliation)
    };
}

function createOperationManager({
    loginToRsGe,
    createRsGeClient,
    executeAccountCheck,
    executeDeclarationReviewAction = executeDeclarationReview,
    executeAction = executeModuleAction,
    moduleManifest = smallBusinessModule,
    recordsRepository,
    logger,
    submissionEnabled = false,
    now = () => Date.now(),
    smsTimeoutMs = 5 * 60 * 1000,
    confirmationTimeoutMs = 5 * 60 * 1000,
    retentionMs = 30 * 60 * 1000
}) {
    const operations = new Map();

    function update(operation, patch) {
        Object.assign(operation, patch, { updatedAt: new Date(now()).toISOString() });
    }

    function getForSession(id, sessionId) {
        const operation = operations.get(id);
        return operation && operation.sessionId === sessionId ? operation : null;
    }

    function findActiveOperation() {
        return [...operations.values()].find((operation) => ACTIVE_STATUSES.has(operation.status));
    }

    function waitForSms(operation) {
        return new Promise((resolve, reject) => {
            update(operation, { status: 'awaiting_sms' });
            operation.smsResolver = resolve;
            operation.smsRejecter = reject;
            operation.smsTimeout = setTimeout(() => {
                const error = new Error('Время ожидания SMS-кода истекло. Запустите проверку снова.');
                error.code = 'SMS_TIMEOUT';
                reject(error);
            }, smsTimeoutMs);
        });
    }

    function clearSms(operation) {
        if (operation.smsTimeout) clearTimeout(operation.smsTimeout);
        delete operation.smsTimeout;
        delete operation.smsResolver;
        delete operation.smsRejecter;
    }

    function waitForConfirmation(operation) {
        return new Promise((resolve, reject) => {
            update(operation, { status: 'awaiting_confirmation' });
            operation.confirmResolver = resolve;
            operation.confirmRejecter = reject;
            operation.confirmTimeout = setTimeout(() => {
                const error = new Error('Время подтверждения истекло. Начните заново и проверьте данные.');
                error.code = 'CONFIRMATION_TIMEOUT';
                reject(error);
            }, confirmationTimeoutMs);
        });
    }

    function clearConfirmation(operation) {
        if (operation.confirmTimeout) clearTimeout(operation.confirmTimeout);
        delete operation.confirmTimeout;
        delete operation.confirmResolver;
        delete operation.confirmRejecter;
    }

    async function run(operation) {
        let loginResult;
        try {
            loginResult = await loginToRsGe(() => waitForSms(operation));
            clearSms(operation);
            update(operation, { status: 'checking' });
            const rsGeClient = createRsGeClient(loginResult.page);
            if (operation.kind === 'check') {
                const result = await executeAccountCheck({
                    recordsRepository, rsGeClient, year: operation.year, month: operation.month
                });
                update(operation, { status: 'completed', result: buildAccountCheckView(result) });
            } else {
                const review = await executeDeclarationReviewAction({
                    recordsRepository, rsGeClient, year: operation.year, month: operation.month
                });
                if (operation.kind === 'draft' && review.exists) {
                    throw new Error('На RS.GE уже есть декларация или черновик за этот период. Сначала проверьте его на портале.');
                }
                const preview = operation.kind === 'draft'
                    ? buildDeclarationDraftPreview({ year: operation.year, month: operation.month, summary: review.summary, yearSummary: review.yearSummary })
                    : buildDeclarationSubmissionPreview({ year: operation.year, month: operation.month, summary: review.summary, yearSummary: review.yearSummary, draft: review.draft });
                const fingerprint = operation.kind === 'draft'
                    ? getDeclarationPreviewFingerprint(preview)
                    : getSubmissionPreviewFingerprint(preview);
                const idempotencyKey = operation.kind === 'draft'
                    ? createDraftIdempotencyKey(preview)
                    : createSubmissionIdempotencyKey(preview);
                if (operation.kind === 'submit' && Buffer.isBuffer(review.draft?.screenshotBuffer)) {
                    operation.previewImage = review.draft.screenshotBuffer;
                }
                update(operation, {
                    preview: {
                        period: preview.period,
                        fields: preview.fields,
                        warnings: preview.warnings || [],
                        sourceStatus: preview.sourceStatus || ''
                    }
                });
                await waitForConfirmation(operation);
                update(operation, { status: 'writing' });
                const result = await executeAction(moduleManifest,
                    operation.kind === 'draft' ? 'create-declaration-draft' : 'submit-declaration',
                    {
                        recordsRepository, rsGeClient, year: operation.year, month: operation.month,
                        previewFingerprint: fingerprint,
                        ...(operation.kind === 'submit' ? { submissionEnabled } : {})
                    },
                    { confirmed: true, idempotencyKey }
                );
                const screenshot = operation.kind === 'draft'
                    ? result.draft?.screenshotBuffer
                    : result.declaration?.screenshotBuffer;
                if (Buffer.isBuffer(screenshot)) operation.resultImage = screenshot;
                update(operation, {
                    status: 'completed',
                    result: operation.kind === 'draft'
                        ? { created: result.created, status: result.draft.status, period: preview.period }
                        : { submitted: result.submitted, status: result.declaration.status, period: preview.period }
                });
            }
        } catch (error) {
            clearSms(operation);
            clearConfirmation(operation);
            logger.error('Web account check failed:', error);
            update(operation, {
                status: 'failed',
                error: ['SMS_TIMEOUT', 'CONFIRMATION_TIMEOUT', 'RSGE_SMS_NOT_SHOWN', 'RSGE_LOGIN_UNCONFIRMED'].includes(error.code)
                    ? error.message
                    : operation.kind === 'check'
                        ? 'Проверка не завершена. Повторите попытку или проверьте журнал сервера.'
                        : error.message || 'Операция не завершена. Проверьте журнал сервера.'
            });
        } finally {
            if (loginResult?.browser) {
                await loginResult.browser.close().catch((error) => {
                    logger.warn('Не удалось закрыть браузер Web-проверки:', error.message);
                });
            }
        }
    }

    function start({ sessionId, year, month, kind = 'check' }) {
        if (!['check', 'draft', 'submit'].includes(kind)) throw new Error('Неизвестное действие');
        if (kind === 'submit' && !submissionEnabled) {
            const error = new Error('Финальная отправка пока отключена.');
            error.code = 'SUBMISSION_DISABLED';
            throw error;
        }
        const active = findActiveOperation();
        if (active) {
            const error = new Error('Другая проверка RS.GE уже выполняется');
            error.code = 'OPERATION_IN_PROGRESS';
            throw error;
        }
        const timestamp = new Date(now()).toISOString();
        const operation = {
            id: crypto.randomUUID(),
            sessionId,
            kind,
            year,
            month,
            status: 'starting',
            createdAt: timestamp,
            updatedAt: timestamp
        };
        operations.set(operation.id, operation);
        setImmediate(() => run(operation));
        return publicOperation(operation);
    }

    function submitSms({ id, sessionId, code }) {
        const operation = getForSession(id, sessionId);
        if (!operation || operation.status !== 'awaiting_sms' || !operation.smsResolver) {
            return false;
        }
        const resolver = operation.smsResolver;
        clearSms(operation);
        update(operation, { status: 'checking' });
        resolver(code);
        return true;
    }

    function confirm({ id, sessionId }) {
        const operation = getForSession(id, sessionId);
        if (!operation || operation.status !== 'awaiting_confirmation' || !operation.confirmResolver) return false;
        const resolve = operation.confirmResolver;
        clearConfirmation(operation);
        update(operation, { status: 'writing' });
        resolve();
        return true;
    }

    function cancel({ id, sessionId }) {
        const operation = getForSession(id, sessionId);
        if (!operation || operation.status !== 'awaiting_confirmation' || !operation.confirmRejecter) return false;
        const reject = operation.confirmRejecter;
        clearConfirmation(operation);
        const error = new Error('Действие отменено пользователем.');
        error.code = 'USER_CANCELLED';
        reject(error);
        return true;
    }

    function get({ id, sessionId }) {
        const operation = getForSession(id, sessionId);
        return operation ? publicOperation(operation) : null;
    }

    function getImage({ id, sessionId, kind }) {
        const operation = getForSession(id, sessionId);
        if (!operation) return null;
        if (kind === 'preview' && operation.status === 'awaiting_confirmation') return operation.previewImage || null;
        if (kind === 'result' && operation.status === 'completed') return operation.resultImage || null;
        return null;
    }

    function cleanup() {
        const timestamp = now();
        for (const [id, operation] of operations) {
            if (!ACTIVE_STATUSES.has(operation.status) && timestamp - Date.parse(operation.updatedAt) > retentionMs) {
                operations.delete(id);
            }
        }
    }

    return Object.freeze({ start, submitSms, confirm, cancel, get, getImage, cleanup });
}

module.exports = {
    ACTIVE_STATUSES,
    buildAccountCheckView,
    createOperationManager,
    publicOperation
};
