const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAccountCheckReport } = require('../workflows/account-check');

function createPeriodCheck(overrides = {}) {
    return {
        report: '✅ Период 10.2026 закрыт\n\nДанные на RS.GE и в Google Sheets не изменялись.',
        reconciliation: {
            results: [{ status: 'date_mismatch' }, { status: 'matched' }],
            unpaidPeriods: [],
            untrackedPortalPayments: [],
            ...overrides.reconciliation
        }
    };
}

test('unified account check recommends reconciliation only for unwritten changes', () => {
    const result = buildAccountCheckReport(createPeriodCheck(), {
        summary: { rowsToUpdate: 1, portalRowsToInsert: 0 }
    });

    assert.equal(result.issueCount, 1);
    assert.equal(result.needsReconciliation, true);
    assert.match(result.report, /История оплат/);
    assert.match(result.report, /Расхождение даты: 1/);
    assert.match(result.report, /можно записать в таблицу/);
    assert.doesNotMatch(result.report, /автоматически не изменялись/);
});

test('unified account check does not offer a redundant write', () => {
    const result = buildAccountCheckReport(createPeriodCheck(), {
        summary: { rowsToUpdate: 0, portalRowsToInsert: 0 }
    });

    assert.equal(result.needsReconciliation, false);
    assert.match(result.report, /уже отражены в Google Sheets/);
});
