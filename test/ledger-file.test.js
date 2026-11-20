const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { exportCsv, exportXlsx, parseImportFile } = require('../web/ledger-file');

const records = [
    { id: 1, recordType: 'Доход', date: '2026-11-18', amountOriginal: 100,
        currency: 'USD', rate: 2.7, amountGel: 270, taxGel: 2.7,
        description: '=HYPERLINK("bad")', paymentDate: '', status: 'Ожидает подачи', source: 'manual' },
    { id: 2, recordType: 'Платёж RS.GE', description: 'Несопоставленный платеж',
        rsPaymentDate: '2026-11-19', rsPaymentAmount: 2.7,
        reconciliationStatus: 'Только в RS.GE', source: 'rs_ge' }
];

test('CSV export preserves the full ledger and import reads incomes without formula execution', async () => {
    const buffer = exportCsv(records);
    assert.ok(buffer.toString('utf8').startsWith('\uFEFF'));
    assert.match(buffer.toString('utf8'), /'=HYPERLINK/);
    const parsed = await parseImportFile({ filename: 'ledger.csv', buffer });
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.portalRows, 1);
    assert.deepEqual(parsed.items[0].input, {
        date: '2026-11-18', amount: '100', currency: 'USD',
        description: '=HYPERLINK("bad")', paymentDate: ''
    });
});

test('XLSX export stores typed numbers and dates and can be read as an import source', async () => {
    const buffer = await exportXlsx(records);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Журнал');
    assert.equal(sheet.getCell('B2').value, 100);
    assert.ok(sheet.getCell('A2').value instanceof Date);
    assert.equal(sheet.getCell('H2').value, '=HYPERLINK("bad")');
    assert.equal(sheet.getCell('J3').value, 'Платёж RS.GE');
    const parsed = await parseImportFile({ filename: 'ledger.xlsx', buffer });
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.portalRows, 1);
    assert.equal(parsed.items[0].input.date, '2026-11-18');
});

test('import rejects missing required columns and unsupported files', async () => {
    await assert.rejects(parseImportFile({ filename: 'bad.csv', buffer: Buffer.from('Дата;Сумма\n2026-11-18;100') }),
        /Нужны колонки/);
    await assert.rejects(parseImportFile({ filename: 'bad.txt', buffer: Buffer.from('hello') }),
        /CSV и XLSX/);
});
