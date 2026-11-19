const crypto = require('crypto');

const ACTIVE_STATUSES = new Set(['starting', 'awaiting_sms', 'checking']);

function publicOperation(operation) {
    return {
        id: operation.id,
        status: operation.status,
        year: operation.year,
        month: operation.month,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
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
    recordsRepository,
    logger,
    now = () => Date.now(),
    smsTimeoutMs = 5 * 60 * 1000,
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

    async function run(operation) {
        let loginResult;
        try {
            loginResult = await loginToRsGe(() => waitForSms(operation));
            clearSms(operation);
            update(operation, { status: 'checking' });
            const result = await executeAccountCheck({
                recordsRepository,
                rsGeClient: createRsGeClient(loginResult.page),
                year: operation.year,
                month: operation.month
            });
            update(operation, {
                status: 'completed',
                result: buildAccountCheckView(result)
            });
        } catch (error) {
            clearSms(operation);
            logger.error('Web account check failed:', error);
            update(operation, {
                status: 'failed',
                error: error.code === 'SMS_TIMEOUT'
                    ? error.message
                    : 'Проверка не завершена. Повторите попытку или проверьте журнал сервера.'
            });
        } finally {
            if (loginResult?.browser) {
                await loginResult.browser.close().catch((error) => {
                    logger.warn('Не удалось закрыть браузер Web-проверки:', error.message);
                });
            }
        }
    }

    function start({ sessionId, year, month }) {
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

    function get({ id, sessionId }) {
        const operation = getForSession(id, sessionId);
        return operation ? publicOperation(operation) : null;
    }

    function cleanup() {
        const timestamp = now();
        for (const [id, operation] of operations) {
            if (!ACTIVE_STATUSES.has(operation.status) && timestamp - Date.parse(operation.updatedAt) > retentionMs) {
                operations.delete(id);
            }
        }
    }

    return Object.freeze({ start, submitSms, get, cleanup });
}

module.exports = {
    ACTIVE_STATUSES,
    buildAccountCheckView,
    createOperationManager,
    publicOperation
};
