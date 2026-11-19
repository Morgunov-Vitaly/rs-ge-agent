const test = require('node:test');
const assert = require('node:assert/strict');

const {
    HEADERS,
    RECORD_TYPES,
    buildPaymentReconciliationBatchData,
    isIncomeRecord,
    parseNumber,
    parseRecordPeriod
} = require('../services/sheets');

test('parseNumber supports formatted Google Sheets values', () => {
    assert.equal(parseNumber('7,277.76'), 7277.76);
    assert.equal(parseNumber('7.277,76'), 7277.76);
    assert.equal(parseNumber('7277,76'), 7277.76);
    assert.equal(parseNumber('72.78'), 72.78);
    assert.equal(parseNumber('2,075.95'), 2075.95);
});

test('parseRecordPeriod accepts supported dates and rejects invalid dates', () => {
    assert.deepEqual(
        parseRecordPeriod('31.10.2026'),
        { year: 2026, month: 10, day: 31, date: new Date(Date.UTC(2026, 9, 31)) }
    );
    assert.equal(parseRecordPeriod('2026-10-31').month, 10);
    assert.equal(parseRecordPeriod('32.10.2026'), null);
    assert.equal(parseRecordPeriod(''), null);
});

test('reconciliation schema separates portal payments from taxable income', () => {
    assert.equal(HEADERS.length, 17);
    assert.deepEqual(HEADERS.slice(9), [
        'Тип записи',
        'Статус сверки RS.GE',
        'Дата платежа RS.GE',
        'Дата проводки RS.GE',
        'Сумма оплаты RS.GE',
        'ID платежа RS.GE',
        'Дата сверки',
        'Комментарий сверки'
    ]);
    assert.equal(isIncomeRecord({ recordType: '' }), true);
    assert.equal(isIncomeRecord({ recordType: RECORD_TYPES.INCOME }), true);
    assert.equal(isIncomeRecord({ recordType: RECORD_TYPES.RS_GE_PAYMENT }), false);
});

test('sheet reconciliation updates only J-Q and inserts portal-only rows with blank tax fields', () => {
    const common = {
        reconciliationStatus: 'Совпадает',
        rsPaymentDate: '17.11.2026',
        rsPostedDate: '18.11.2026',
        rsPaymentAmount: 73,
        rsPaymentId: 'rsge:fixture',
        reconciledAt: '19.11.2026 13:00:00',
        reconciliationComment: 'fixture'
    };
    const data = buildPaymentReconciliationBatchData({
        updates: [{ rowIndex: 2, recordType: RECORD_TYPES.INCOME, ...common }],
        inserts: [{
            rowIndex: 5,
            recordType: RECORD_TYPES.RS_GE_PAYMENT,
            description: 'Несопоставленный платеж RS.GE',
            ...common
        }]
    });

    assert.equal(data[1].range, 'Лист1!J2:Q2');
    assert.equal(data[1].values[0].length, 8);
    assert.equal(data[2].range, 'Лист1!A5:Q5');
    assert.deepEqual(data[2].values[0].slice(0, 7), ['', '', '', '', '', '', '']);
    assert.equal(data[2].values[0][7], 'Несопоставленный платеж RS.GE');
    assert.equal(data[2].values[0][9], RECORD_TYPES.RS_GE_PAYMENT);
});
