const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createPortalPaymentId,
    groupSheetPayments,
    reconcilePayments,
    formatPaymentReport
} = require('../services/payments');
const {
    parseRsGeDate,
    parsePaymentOrderDate,
    parsePayerCardRows
} = require('../services/playwright');

test('groups several tax rows paid by one bank order', () => {
    const groups = groupSheetPayments([
        { rowIndex: 2, date: '2026-04-10', taxGel: 74.89, paymentDate: '15.06.2026' },
        { rowIndex: 3, date: '2026-05-10', taxGel: 74.21, paymentDate: '15.06.2026' }
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].paymentDate, '2026-06-15');
    assert.equal(groups[0].expectedAmount, 149.1);
    assert.deepEqual(groups[0].periods, ['04.2026', '05.2026']);
});

test('matches a rounded RS.GE payment by payment-order date', () => {
    const records = [
        { date: '2026-10-20', taxGel: 72.78, paymentDate: '17.11.2026' }
    ];
    const portalPayments = [
        { paymentDate: '2026-11-17', postedDate: '2026-11-18', amount: 73 }
    ];

    const result = reconcilePayments(records, portalPayments);
    assert.equal(result.matchedCount, 1);
    assert.equal(result.warningCount, 0);
    assert.equal(result.results[0].status, 'matched');
    assert.equal(result.results[0].amountDelta, 0.22);
});

test('reports a nearby date as a warning instead of silently accepting it', () => {
    const records = [
        { date: '2026-07-20', taxGel: 73.56, paymentDate: '16.08.2026' }
    ];
    const portalPayments = [
        { paymentDate: '2026-08-15', postedDate: '2026-08-17', amount: 73 }
    ];

    const result = reconcilePayments(records, portalPayments);
    assert.equal(result.results[0].status, 'date_mismatch');
    assert.equal(result.results[0].dateDifferenceDays, 1);
    assert.equal(result.warningCount, 1);
    assert.match(formatPaymentReport(result), /Дата отличается/);
});

test('parses Georgian payer-card dates and payment rows', () => {
    assert.equal(parseRsGeDate('18-ნოე-2026'), '2026-11-18');
    assert.equal(
        parsePaymentOrderDate('8-გადახდილია-33-საგადასახადო დავალებით-17/11/2026 - TBC'),
        '2026-11-17'
    );

    const paymentRow = Array(20).fill('0');
    paymentRow[0] = '18-ნოე-2026';
    paymentRow[1] = '60-სხვა';
    // Synthetic document and reference numbers: never use production payer-card data in fixtures.
    paymentRow[2] = '8-გადახდილია-33-საგადასახადო დავალებით-17/11/2026 - 1234567 rs.ge1, TBC; 999999999999';
    paymentRow[3] = '18-ნოე-2026';
    paymentRow[8] = '73';

    const parsed = parsePayerCardRows([paymentRow]);
    assert.equal(parsed.payments.length, 1);
    assert.deepEqual(parsed.payments[0], {
        paymentDate: '2026-11-17',
        postedDate: '2026-11-18',
        effectiveDate: '2026-11-18',
        amount: 73,
        description: paymentRow[2],
        reference: '999999999999'
    });
});

test('does not report an imported portal-only payment as untracked again', () => {
    const portalPayment = {
        paymentDate: '2026-08-01',
        postedDate: '2026-08-02',
        amount: 12,
        reference: 'fixture-imported-payment'
    };
    const result = reconcilePayments([
        {
            recordType: 'Платёж RS.GE',
            rsPaymentId: createPortalPaymentId(portalPayment),
            taxGel: 0
        }
    ], [portalPayment]);

    assert.equal(result.untrackedPortalPayments.length, 0);
});
