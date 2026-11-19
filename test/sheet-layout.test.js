const test = require('node:test');
const assert = require('node:assert/strict');

const { HEADERS } = require('../services/sheets');
const {
    buildDataFormatRequests,
    buildSummaryValues,
    normalizeNumericColumns
} = require('../services/sheet-layout');

test('sheet layout converts displayed financial values to typed numbers', () => {
    const formattedRows = [
        HEADERS,
        ['12.01.2024', '2,075.95', 'EUR', '2.9415', '6,106.41', '61.06', '', '', '', '', '', '', '', '61,06'],
        ['', '', '', '', '', '', '', '', '', 'Платёж RS.GE', '', '', '', '12,50']
    ];
    const formulaRows = formattedRows.map((row) => [...row]);
    const result = normalizeNumericColumns(formattedRows, formulaRows);
    const byColumn = new Map(result.data.map((item) => [item.range.match(/!([A-Z])/)[1], item.values]));

    assert.equal(result.lastRow, 3);
    assert.deepEqual(byColumn.get('B'), [[2075.95], ['']]);
    assert.deepEqual(byColumn.get('D'), [[2.9415], ['']]);
    assert.deepEqual(byColumn.get('E'), [[6106.41], ['']]);
    assert.deepEqual(byColumn.get('F'), [[61.06], ['']]);
    assert.deepEqual(byColumn.get('N'), [[61.06], [12.5]]);
});

test('summary formulas follow the Russian Google Sheets locale', () => {
    const values = buildSummaryValues('ru_RU');

    assert.equal(values[0][0], 'Налоговый учет ИП в Грузии');
    assert.match(values[4][1], /^=SUM\('Лист1'!E2:E\)$/);
    assert.match(values[6][1], /SUMIFS\(.+;.+DATE\(YEAR\(TODAY\(\)\);1;1\)/);
    assert.match(values[9][1], /COUNTIF\(.+;"Расхождение\*"\)/);
});

test('data formatting adds a filter, banding and locale-safe number formats', () => {
    const requests = buildDataFormatRequests({
        sheetId: 0,
        rowCount: 1000,
        tableEndRow: 39,
        bandedRangeId: null,
        basicFilter: null,
        hasConditionalFormats: false
    });

    assert.ok(requests.some(({ setBasicFilter }) => Boolean(setBasicFilter)));
    assert.ok(requests.some(({ addBanding }) => Boolean(addBanding)));
    assert.ok(requests.some(({ repeatCell }) => (
        repeatCell?.cell?.userEnteredFormat?.numberFormat?.pattern === '0.0000'
    )));
    assert.ok(requests.some(({ addConditionalFormatRule }) => Boolean(addConditionalFormatRule)));
});
