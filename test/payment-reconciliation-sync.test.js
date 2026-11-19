const test = require('node:test');
const assert = require('node:assert/strict');

const { ACTION_RISKS, executeModuleAction } = require('../core/action-contract');
const smallBusinessModule = require('../modules/small-business/manifest');
const payments = require('../services/payments');
const { RECORD_TYPES } = require('../services/sheets');
const {
    buildPaymentReconciliationPreview,
    createPortalPaymentId
} = require('../workflows/payment-reconciliation-sync');

function createMemoryAuditLog() {
    const events = [];
    return {
        events,
        async record(event) {
            events.push(event);
            return event;
        }
    };
}

function scenario() {
    const records = [
        {
            rowIndex: 2,
            date: '2026-10-20',
            taxGel: 72.78,
            paymentDate: '17.11.2026'
        },
        {
            rowIndex: 3,
            date: '2026-09-20',
            taxGel: 50,
            paymentDate: '15.10.2026'
        }
    ];
    const portalHistory = {
        payments: [
            {
                paymentDate: '2026-11-17',
                postedDate: '2026-11-18',
                amount: 73,
                reference: 'fixture-matched-payment'
            },
            {
                paymentDate: '2026-08-01',
                postedDate: '2026-08-02',
                amount: 12,
                reference: 'fixture-untracked-payment'
            }
        ],
        charges: [],
        balance: { debt: 0, overpayment: 0 }
    };
    const reconciliation = payments.reconcilePayments(records, portalHistory.payments);
    return { records, portalHistory, reconciliation };
}

test('builds a confirmed sheet-write preview without touching income columns', () => {
    const data = scenario();
    const preview = buildPaymentReconciliationPreview({
        records: data.records,
        reconciliation: data.reconciliation,
        reconciledAt: '19.11.2026 13:00:00'
    });

    assert.equal(preview.risk, ACTION_RISKS.DATA_WRITE);
    assert.equal(preview.summary.matched, 1);
    assert.equal(preview.summary.missingOnPortal, 1);
    assert.equal(preview.summary.rowsToUpdate, 2);
    assert.equal(preview.summary.portalRowsToInsert, 1);
    assert.deepEqual(
        preview.plan.updates.map(({ rowIndex }) => rowIndex).sort((left, right) => left - right),
        [2, 3]
    );
    const updatesByRow = new Map(preview.plan.updates.map((update) => [update.rowIndex, update]));
    assert.equal(updatesByRow.get(2).recordType, RECORD_TYPES.INCOME);
    assert.equal(updatesByRow.get(2).rsPaymentAmount, 73);
    assert.equal(updatesByRow.get(3).rsPaymentAmount, null);
    assert.deepEqual(preview.plan.inserts[0], {
        rowIndex: 4,
        description: 'Несопоставленный платеж RS.GE',
        recordType: RECORD_TYPES.RS_GE_PAYMENT,
        reconciliationStatus: 'Только в RS.GE',
        rsPaymentDate: '01.08.2026',
        rsPostedDate: '02.08.2026',
        rsPaymentAmount: 12,
        rsPaymentId: 'rsge:fixture-untracked-payment',
        reconciledAt: '19.11.2026 13:00:00',
        reconciliationComment: 'Платёж RS.GE не сопоставлен со строками дохода'
    });
});

test('does not propose a duplicate row for an already imported portal payment', () => {
    const data = scenario();
    data.records.push({
        rowIndex: 4,
        recordType: RECORD_TYPES.RS_GE_PAYMENT,
        rsPaymentId: createPortalPaymentId(data.portalHistory.payments[1])
    });
    const preview = buildPaymentReconciliationPreview({
        records: data.records,
        reconciliation: data.reconciliation
    });

    assert.equal(preview.summary.portalRowsToInsert, 0);
    assert.equal(preview.summary.existingPortalRows, 1);
});

test('writes a reconciliation plan only through confirmed DATA_WRITE action', async () => {
    const data = scenario();
    const preview = buildPaymentReconciliationPreview({
        records: data.records,
        reconciliation: data.reconciliation
    });
    const auditLog = createMemoryAuditLog();
    let appliedPlan;
    const input = {
        recordsRepository: {
            getAllRecords: async () => data.records,
            applyPaymentReconciliationPlan: async (plan) => {
                appliedPlan = plan;
                return { updatedRows: plan.updates.length, insertedRows: plan.inserts.length };
            }
        },
        rsGeClient: {
            getPaymentHistory: async () => data.portalHistory
        },
        previewFingerprint: preview.fingerprint,
        currentYear: 2026,
        auditLog
    };

    await assert.rejects(
        executeModuleAction(smallBusinessModule, 'sync-payment-reconciliation', input),
        ({ code }) => code === 'CONFIRMATION_REQUIRED'
    );
    const result = await executeModuleAction(
        smallBusinessModule,
        'sync-payment-reconciliation',
        input,
        { confirmed: true, idempotencyKey: preview.idempotencyKey }
    );

    assert.equal(result.writeResult.updatedRows, 2);
    assert.equal(result.writeResult.insertedRows, 1);
    assert.equal(appliedPlan.updates.length, 2);
    assert.deepEqual(auditLog.events.map(({ status }) => status), ['started', 'completed']);
    assert.ok(auditLog.events.every(({ risk }) => risk === ACTION_RISKS.DATA_WRITE));
});

test('rejects a stale reconciliation preview before writing to Google Sheets', async () => {
    const data = scenario();
    const preview = buildPaymentReconciliationPreview({
        records: data.records,
        reconciliation: data.reconciliation
    });
    let writeCalls = 0;

    let staleError;
    await assert.rejects(
        executeModuleAction(
            smallBusinessModule,
            'sync-payment-reconciliation',
            {
                recordsRepository: {
                    getAllRecords: async () => data.records.map((record) => (
                        record.rowIndex === 2
                            ? { ...record, reconciliationStatus: 'Изменено вручную' }
                            : record
                    )),
                    applyPaymentReconciliationPlan: async () => {
                        writeCalls += 1;
                    }
                },
                rsGeClient: { getPaymentHistory: async () => data.portalHistory },
                previewFingerprint: preview.fingerprint,
                currentYear: 2026,
                auditLog: createMemoryAuditLog()
            },
            { confirmed: true, idempotencyKey: preview.idempotencyKey }
        ),
        (error) => {
            staleError = error;
            return error.code === 'PAYMENT_RECONCILIATION_STALE';
        }
    );
    assert.equal(writeCalls, 0);
    assert.equal(staleError.code, 'PAYMENT_RECONCILIATION_STALE');
    assert.ok(staleError.refreshedPreview);
    assert.notEqual(staleError.refreshedPreview.fingerprint, preview.fingerprint);
});

test('rejects a preview when a reconciliation source cell changes', async () => {
    const data = scenario();
    const preview = buildPaymentReconciliationPreview({
        records: data.records,
        reconciliation: data.reconciliation
    });
    const changedRecords = data.records.map((record) => (
        record.rowIndex === 2 ? { ...record, date: '2026-10-21' } : record
    ));
    const changedReconciliation = payments.reconcilePayments(
        changedRecords,
        data.portalHistory.payments
    );
    const changedPreview = buildPaymentReconciliationPreview({
        records: changedRecords,
        reconciliation: changedReconciliation
    });

    assert.notEqual(changedPreview.fingerprint, preview.fingerprint);
});
