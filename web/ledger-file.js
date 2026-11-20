const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const { HEADERS, RECORD_TYPES, parseNumber } = require('../services/sheets');
const { parseRecordPeriod } = require('../domain/dates');

const EXPORT_HEADERS = Object.freeze([...HEADERS, 'ID записи', 'Источник записи']);
const MAX_IMPORT_ROWS = 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const NUMERIC_COLUMNS = new Set([1, 3, 4, 5, 13]);
const DATE_COLUMNS = new Set([0, 6, 11, 12]);

function fileError(message, code = 'INVALID_LEDGER_FILE') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isoDate(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    const parsed = parseRecordPeriod(String(value).trim());
    return parsed ? `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}` : String(value).trim();
}

function exportValues(record) {
    const income = !record.recordType || record.recordType === RECORD_TYPES.INCOME;
    return [
        income ? isoDate(record.date) : '',
        income ? Number(record.amountOriginal || 0) : '',
        income ? record.currency || '' : '',
        income ? Number(record.rate || 0) : '',
        income ? Number(record.amountGel || 0) : '',
        income ? Number(record.taxGel || 0) : '',
        income ? isoDate(record.paymentDate) : '',
        record.description || '',
        record.status || '',
        income ? RECORD_TYPES.INCOME : RECORD_TYPES.RS_GE_PAYMENT,
        record.reconciliationStatus || '',
        isoDate(record.rsPaymentDate),
        isoDate(record.rsPostedDate),
        record.rsPaymentAmount === null || record.rsPaymentAmount === undefined ? '' : Number(record.rsPaymentAmount),
        record.rsPaymentId || '',
        record.reconciledAt || '',
        record.reconciliationComment || '',
        record.id || '',
        record.source || ''
    ];
}

function csvCell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+@\-\t\r]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv(records) {
    const lines = [EXPORT_HEADERS, ...records.map(exportValues)]
        .map((row) => row.map(csvCell).join(';'));
    return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

async function exportXlsx(records) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'RS.GE Agent';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Журнал');
    sheet.columns = EXPORT_HEADERS.map((header, index) => ({
        header,
        width: [15, 18, 12, 13, 17, 17, 16, 38, 20, 18, 22, 19, 19, 19, 28, 22, 44, 15, 18][index]
    }));
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: EXPORT_HEADERS.length } };
    sheet.getRow(1).height = 30;
    sheet.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF18324B' } };
        cell.alignment = { vertical: 'middle', wrapText: true };
    });
    for (const record of records) {
        const values = exportValues(record).map((value, index) => {
            if (DATE_COLUMNS.has(index) && value) return new Date(`${value}T12:00:00Z`);
            return value;
        });
        const row = sheet.addRow(values);
        for (const column of NUMERIC_COLUMNS) row.getCell(column + 1).numFmt = '#,##0.00';
        for (const column of DATE_COLUMNS) row.getCell(column + 1).numFmt = 'dd.mm.yyyy';
        row.alignment = { vertical: 'middle' };
        if (row.number % 2 === 0) row.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7F9' } };
        });
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

function normalizedHeader(value) {
    return String(value ?? '').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
}

function findColumn(headers, names) {
    const aliases = new Set(names.map(normalizedHeader));
    return headers.findIndex((header) => aliases.has(normalizedHeader(header)));
}

function plainCell(value) {
    if (value instanceof Date) return isoDate(value);
    if (value && typeof value === 'object') {
        throw fileError('Формулы и сложные ячейки в импортируемых данных не поддерживаются.');
    }
    const text = String(value ?? '').trim();
    return /^'[=+@\-\t\r]/.test(text) ? text.slice(1) : text;
}

function parseRows(table) {
    if (!table.length) throw fileError('Файл пуст. Добавьте строку заголовков и записи.');
    const headers = table[0];
    const columns = {
        date: findColumn(headers, ['Дата', 'date', 'Дата поступления']),
        amount: findColumn(headers, ['Сумма (валюта)', 'amount', 'amount_original', 'Сумма']),
        currency: findColumn(headers, ['Валюта', 'currency']),
        description: findColumn(headers, ['Описание / Источник', 'Описание', 'description']),
        paymentDate: findColumn(headers, ['Дата оплаты', 'payment_date']),
        type: findColumn(headers, ['Тип записи', 'record_type'])
    };
    if (['date', 'amount', 'currency', 'description'].some((name) => columns[name] < 0)) {
        throw fileError('Нужны колонки «Дата», «Сумма (валюта)», «Валюта» и «Описание / Источник».');
    }
    if (table.length - 1 > MAX_IMPORT_ROWS) throw fileError(`В одном файле допускается не более ${MAX_IMPORT_ROWS} строк.`);
    const items = [];
    let portalRows = 0;
    for (let index = 1; index < table.length; index += 1) {
        const row = table[index];
        if (!row.some((value) => value !== '' && value !== null && value !== undefined)) continue;
        const type = columns.type < 0 ? '' : plainCell(row[columns.type]);
        if (type === RECORD_TYPES.RS_GE_PAYMENT) { portalRows += 1; continue; }
        if (type && type !== RECORD_TYPES.INCOME) {
            throw fileError(`Строка ${index + 1}: неизвестный тип записи «${type}».`);
        }
        items.push({ line: index + 1, input: {
            date: isoDate(plainCell(row[columns.date])),
            amount: plainCell(row[columns.amount]) ? String(parseNumber(plainCell(row[columns.amount]))) : '',
            currency: plainCell(row[columns.currency]),
            description: plainCell(row[columns.description]),
            paymentDate: columns.paymentDate < 0 ? '' : isoDate(plainCell(row[columns.paymentDate]))
        } });
    }
    return { items, portalRows };
}

async function parseImportFile({ filename, buffer }) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_FILE_BYTES) {
        throw fileError('Файл пуст или превышает 2 МБ.');
    }
    const extension = String(filename || '').toLowerCase().split('.').at(-1);
    if (extension === 'csv') {
        const text = buffer.toString('utf8');
        if (text.includes('\u0000')) throw fileError('CSV должен быть в кодировке UTF-8.');
        const firstLine = text.split(/\r?\n/, 1)[0];
        const delimiter = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
        try {
            return parseRows(parse(text, { bom: true, delimiter, skip_empty_lines: true,
                relax_column_count: true, max_record_size: 32 * 1024 }));
        } catch (error) {
            if (error.code === 'INVALID_LEDGER_FILE') throw error;
            throw fileError(`Не удалось прочитать CSV: ${error.message}`);
        }
    }
    if (extension === 'xlsx') {
        if (buffer.subarray(0, 2).toString('latin1') !== 'PK') throw fileError('Файл XLSX поврежден или имеет неверный формат.');
        const workbook = new ExcelJS.Workbook();
        try { await workbook.xlsx.load(buffer); }
        catch { throw fileError('Не удалось прочитать XLSX. Проверьте файл.'); }
        const sheet = workbook.getWorksheet('Журнал') || workbook.worksheets[0];
        if (!sheet) throw fileError('В XLSX нет листа с данными.');
        if (sheet.rowCount - 1 > MAX_IMPORT_ROWS) throw fileError(`В одном файле допускается не более ${MAX_IMPORT_ROWS} строк.`);
        const table = [];
        sheet.eachRow({ includeEmpty: true }, (row) => {
            table.push(Array.from({ length: Math.min(sheet.columnCount, 50) }, (_, index) => row.getCell(index + 1).value ?? ''));
        });
        return parseRows(table);
    }
    throw fileError('Поддерживаются только файлы CSV и XLSX.');
}

module.exports = { EXPORT_HEADERS, MAX_FILE_BYTES, exportCsv, exportXlsx, parseImportFile };
