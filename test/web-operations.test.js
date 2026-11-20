const test = require('node:test');
const assert = require('node:assert/strict');

const { createOperationManager } = require('../web/operations');
const { operationView } = require('../web/views');

async function waitFor(getValue, predicate, timeoutMs = 1_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const value = getValue();
        if (predicate(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for operation state');
}

function completedResult() {
    return {
        period: '10.2026',
        verdict: 'closed',
        report: '✅ Период 10.2026 закрыт',
        summary: { totalIncomeGel: 1000, totalTaxGel: 10, status: 'Подана' },
        declaration: { exists: true, status: 'Sent', metadata: {} },
        portalHistory: { balance: { debt: 0, overpayment: 0 } },
        paymentSatisfied: true,
        debtClear: true,
        issueCount: 0,
        counts: { matched: 1, dateMismatch: 0, amountMismatch: 0, missingOnPortal: 0 },
        needsReconciliation: false
    };
}

test('web read-only operation waits for SMS and returns a sanitized result', async () => {
    let receivedCode;
    const manager = createOperationManager({
        loginToRsGe: async (requestSms) => {
            receivedCode = await requestSms(Buffer.from('not-exposed'));
            return { page: {}, browser: { close: async () => undefined } };
        },
        createRsGeClient: () => ({ readOnly: true }),
        executeAccountCheck: async ({ rsGeClient }) => {
            assert.equal(rsGeClient.readOnly, true);
            return completedResult();
        },
        recordsRepository: {},
        logger: { error() {}, warn() {} }
    });

    const started = manager.start({ sessionId: 'session-1', year: 2026, month: 10 });
    const waiting = await waitFor(
        () => manager.get({ id: started.id, sessionId: 'session-1' }),
        (operation) => operation.status === 'awaiting_sms'
    );
    assert.equal(waiting.result, null);
    assert.equal(manager.get({ id: started.id, sessionId: 'another-session' }), null);
    assert.equal(manager.submitSms({
        id: started.id,
        sessionId: 'session-1',
        code: '12345'
    }), true);

    const completed = await waitFor(
        () => manager.get({ id: started.id, sessionId: 'session-1' }),
        (operation) => operation.status === 'completed'
    );
    assert.equal(receivedCode, '12345');
    assert.equal(completed.result.verdict, 'closed');
    assert.equal(completed.result.incomeGel, 1000);
    assert.equal('records' in completed.result, false);
    assert.equal('portalHistory' in completed.result, false);
});

test('web operation manager permits only one active RS.GE browser flow', async () => {
    const manager = createOperationManager({
        loginToRsGe: async (requestSms) => {
            await requestSms();
            return { page: {}, browser: { close: async () => undefined } };
        },
        createRsGeClient: () => ({}),
        executeAccountCheck: async () => completedResult(),
        recordsRepository: {},
        logger: { error() {}, warn() {} },
        smsTimeoutMs: 100
    });
    const first = manager.start({ sessionId: 'one', year: 2026, month: 10 });
    await waitFor(
        () => manager.get({ id: first.id, sessionId: 'one' }),
        (operation) => operation.status === 'awaiting_sms'
    );
    assert.throws(
        () => manager.start({ sessionId: 'two', year: 2026, month: 10 }),
        ({ code }) => code === 'OPERATION_IN_PROGRESS'
    );
    manager.submitSms({ id: first.id, sessionId: 'one', code: '1234' });
    await waitFor(
        () => manager.get({ id: first.id, sessionId: 'one' }),
        (operation) => operation.status === 'completed'
    );
});

test('web operation reports an actionable login error without exposing a false success', async () => {
    const error = new Error('RS.GE не показал поле SMS. Проверьте данные входа.');
    error.code = 'RSGE_SMS_NOT_SHOWN';
    const manager = createOperationManager({
        loginToRsGe: async () => { throw error; },
        createRsGeClient: () => ({}),
        executeAccountCheck: async () => { throw new Error('must not run'); },
        recordsRepository: {},
        logger: { error() {}, warn() {} }
    });
    const started = manager.start({ sessionId: 'one', year: 2026, month: 10 });
    const failed = await waitFor(
        () => manager.get({ id: started.id, sessionId: 'one' }),
        (operation) => operation.status === 'failed'
    );
    assert.match(failed.error, /Проверьте данные входа/);
    assert.equal(failed.result, null);
    const html = operationView({
        session: { csrfToken: 'test-csrf' },
        operation: failed
    });
    assert.match(html, /Проверка не завершена/);
    assert.doesNotMatch(html, /Проверка завершена без изменения данных/);
});

test('web draft waits for confirmation before saving and rejects a second click', async () => {
    let writes = 0;
    const manager = createOperationManager({
        loginToRsGe: async () => ({ page: {}, browser: { close: async () => undefined } }),
        createRsGeClient: () => ({}),
        executeAccountCheck: async () => { throw new Error('wrong action'); },
        executeDeclarationReviewAction: async () => ({
            exists: false,
            summary: { totalIncomeGel: 100, totalTaxGel: 1, recordsCount: 1 },
            yearSummary: { totalIncomeGel: 100 }
        }),
        executeAction: async (_manifest, actionId, input, execution) => {
            assert.equal(actionId, 'create-declaration-draft');
            assert.equal(execution.confirmed, true);
            assert.ok(input.previewFingerprint);
            writes += 1;
            return { created: true, draft: { status: 'Draft', screenshotBuffer: Buffer.from('png-data') } };
        },
        recordsRepository: {},
        logger: { error() {}, warn() {} }
    });
    const started = manager.start({ sessionId: 'owner', year: 2026, month: 10, kind: 'draft' });
    const reviewing = await waitFor(
        () => manager.get({ id: started.id, sessionId: 'owner' }),
        (operation) => operation.status === 'awaiting_confirmation'
    );
    assert.equal(reviewing.preview.fields[20], 100);
    assert.equal(manager.getImage({ id: started.id, sessionId: 'owner', kind: 'result' }), null);
    assert.equal(writes, 0);
    assert.equal(manager.confirm({ id: started.id, sessionId: 'intruder' }), false);
    assert.equal(manager.confirm({ id: started.id, sessionId: 'owner' }), true);
    assert.equal(manager.confirm({ id: started.id, sessionId: 'owner' }), false);
    const completed = await waitFor(
        () => manager.get({ id: started.id, sessionId: 'owner' }),
        (operation) => operation.status === 'completed'
    );
    assert.equal(completed.result.created, true);
    assert.equal(completed.hasResultImage, true);
    assert.equal(manager.getImage({ id: started.id, sessionId: 'intruder', kind: 'result' }), null);
    assert.equal(manager.getImage({ id: started.id, sessionId: 'owner', kind: 'result' }).toString(), 'png-data');
    assert.equal(writes, 1);
});

test('web submission cannot start while safety flag is disabled', () => {
    const manager = createOperationManager({
        loginToRsGe: async () => { throw new Error('must not log in'); },
        createRsGeClient: () => ({}),
        executeAccountCheck: async () => ({}),
        recordsRepository: {},
        logger: { error() {}, warn() {} }
    });
    assert.throws(
        () => manager.start({ sessionId: 'owner', year: 2026, month: 10, kind: 'submit' }),
        { code: 'SUBMISSION_DISABLED' }
    );
});

test('cancelling web draft releases the browser without writing', async () => {
    let closed = false;
    let writes = 0;
    const manager = createOperationManager({
        loginToRsGe: async () => ({ page: {}, browser: { close: async () => { closed = true; } } }),
        createRsGeClient: () => ({}),
        executeAccountCheck: async () => ({}),
        executeDeclarationReviewAction: async () => ({
            exists: false,
            summary: { totalIncomeGel: 100, totalTaxGel: 1, recordsCount: 1 },
            yearSummary: { totalIncomeGel: 100 }
        }),
        executeAction: async () => { writes += 1; },
        recordsRepository: {},
        logger: { error() {}, warn() {} }
    });
    const started = manager.start({ sessionId: 'owner', year: 2026, month: 10, kind: 'draft' });
    await waitFor(
        () => manager.get({ id: started.id, sessionId: 'owner' }),
        (operation) => operation.status === 'awaiting_confirmation'
    );
    assert.equal(manager.cancel({ id: started.id, sessionId: 'owner' }), true);
    await waitFor(
        () => manager.get({ id: started.id, sessionId: 'owner' }),
        (operation) => operation.status === 'failed'
    );
    await waitFor(() => closed, Boolean);
    assert.equal(writes, 0);
    assert.equal(closed, true);
});
