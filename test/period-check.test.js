const test = require('node:test');
const assert = require('node:assert/strict');

const { ACTION_RISKS } = require('../core/action-contract');
const { executePeriodCheck } = require('../workflows/period-check');

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

function createScenario(overrides = {}) {
    const summary = {
        totalIncomeGel: 7277.76,
        totalTaxGel: 72.78,
        isFiled: true,
        isPaid: true,
        paymentDate: '17.11.2026',
        status: 'Подана',
        ...overrides.summary
    };
    const yearSummary = { totalIncomeGel: 71617.04, ...overrides.yearSummary };
    const records = overrides.records || [{
        date: '2026-10-20',
        taxGel: 72.78,
        paymentDate: '17.11.2026'
    }];
    const declaration = {
        exists: true,
        status: 'Sent',
        fields: { 15: 71617.04, 20: 7277.76, 26: 72.78 },
        metadata: {
            registrationNumber: 'fixture-registration',
            submittedAt: '17.11.2026 21:16'
        },
        ...overrides.declaration
    };
    const portalHistory = {
        payments: [{ paymentDate: '2026-11-17', amount: 73 }],
        charges: [{ amount: 72.78 }],
        balance: { debt: 0, overpayment: 0 },
        ...overrides.portalHistory
    };

    return {
        recordsRepository: {
            getMonthlySummary: async () => summary,
            getYearlySummary: async () => yearSummary,
            getAllRecords: async () => records
        },
        rsGeClient: {
            openExistingSmallBusinessDraft: async () => declaration,
            getPaymentHistory: async ({ years }) => {
                assert.deepEqual(years, [2026]);
                return portalHistory;
            }
        }
    };
}

test('confirms a period closed only when declaration, payment and debt agree', async () => {
    const auditLog = createMemoryAuditLog();
    const result = await executePeriodCheck({
        ...createScenario(),
        year: 2026,
        month: 10,
        currentYear: 2026,
        auditLog
    });

    assert.equal(result.verdict, 'closed');
    assert.equal(result.portalClosed, true);
    assert.equal(result.recordsConsistent, true);
    assert.match(result.report, /Период 10\.2026 закрыт/);
    assert.match(result.report, /Дата подачи: 17\.11\.2026/);
    assert.match(result.report, /Оплата: подтверждена/);
    assert.deepEqual(auditLog.events.map(({ status }) => status), ['started', 'completed']);
    assert.ok(auditLog.events.every(({ risk }) => risk === ACTION_RISKS.READ_ONLY));
    assert.equal(JSON.stringify(auditLog.events).includes('fixture-registration'), false);
});

test('separates a closed portal period from stale Google Sheets status', async () => {
    const result = await executePeriodCheck({
        ...createScenario({ summary: { isFiled: false, status: 'Ожидает подачи' } }),
        year: 2026,
        month: 10,
        currentYear: 2026,
        auditLog: createMemoryAuditLog()
    });

    assert.equal(result.verdict, 'portal-closed-sheet-mismatch');
    assert.equal(result.portalClosed, true);
    assert.equal(result.recordsConsistent, false);
    assert.match(result.report, /журнал требует сверки/);
    assert.match(result.report, /Статус подачи в журнале не совпадает/);
});

test('requires attention when the declaration is not sent and debt remains', async () => {
    const result = await executePeriodCheck({
        ...createScenario({
            declaration: { status: 'Сохранен' },
            portalHistory: { balance: { debt: 72.78, overpayment: 0 } }
        }),
        year: 2026,
        month: 10,
        currentYear: 2026,
        auditLog: createMemoryAuditLog()
    });

    assert.equal(result.verdict, 'attention');
    assert.equal(result.portalClosed, false);
    assert.match(result.report, /требует внимания/);
    assert.match(result.report, /Декларация на RS.GE не отправлена/);
    assert.match(result.report, /есть задолженность/);
});

test('explains a missing portal declaration as one consolidated warning', async () => {
    const result = await executePeriodCheck({
        ...createScenario({ declaration: { exists: false } }),
        year: 2026,
        month: 10,
        currentYear: 2026,
        auditLog: createMemoryAuditLog()
    });

    assert.equal(result.verdict, 'attention');
    assert.match(
        result.report,
        /не нашла декларацию на RS\.GE, хотя в журнале она отмечена как поданна/
    );
    assert.doesNotMatch(result.report, /Статус подачи в журнале не совпадает/);
});
