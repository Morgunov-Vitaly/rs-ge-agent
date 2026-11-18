/**
 * services/sheets.js
 * Модуль интеграции с Google Sheets API.
 * Ведение журнала доходов, проверка дубликатов, расчет итогов по месяцам.
 */

const { google } = require('googleapis');
const { config, assertConfig } = require('../config');
const { parseRecordPeriod } = require('../domain/dates');

const SPREADSHEET_ID = config.google.spreadsheetId;
const CREDENTIALS_PATH = config.google.credentialsPath;

const HEADERS = [
    'Дата',
    'Сумма (валюта)',
    'Валюта',
    'Курс NBG',
    'Сумма (GEL)',
    'Налог 1% (GEL)',
    'Дата оплаты',
    'Описание / Источник',
    'Статус декларации'
];

/**
 * Парсер чисел с поддержкой локализованных разделителей (запятая/точка)
 */
function parseNumber(val) {
    if (val === undefined || val === null || val === '') return 0;
    if (typeof val === 'number') return val;

    let cleaned = String(val).trim().replace(/[\s']/g, '');
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    // Поддерживаем оба распространенных формата:
    // 7,277.76 и 7.277,76, а также обычные 7277,76 / 7277.76.
    if (lastComma !== -1 && lastDot !== -1) {
        if (lastDot > lastComma) {
            cleaned = cleaned.replace(/,/g, '');
        } else {
            cleaned = cleaned.replace(/\./g, '').replace(',', '.');
        }
    } else if (lastComma !== -1) {
        const decimalDigits = cleaned.length - lastComma - 1;
        cleaned = decimalDigits === 3
            ? cleaned.replace(/,/g, '')
            : cleaned.replace(',', '.');
    }

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Создает авторизованный клиент Google Sheets
 */
function getSheetsClient() {
    assertConfig(config, ['google']);

    const auth = new google.auth.GoogleAuth({
        keyFile: CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    return google.sheets({ version: 'v4', auth });
}

/**
 * Инициализирует заголовки таблицы, если лист пустой
 */
async function initSheetHeaders(sheetName = 'Лист1') {
    const sheets = getSheetsClient();

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!A1:I1`
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0 || rows[0].length === 0) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A1:I1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [HEADERS]
                }
            });
            console.log(`Заголовки таблицы ${sheetName} успешно инициализированы.`);
        }
    } catch (error) {
        if (sheetName === 'Лист1' && error.message.includes('Unable to parse range')) {
            return initSheetHeaders('Sheet1');
        }
        throw error;
    }
}

/**
 * Получить все строки из таблицы
 */
async function getAllRecords(sheetName = 'Лист1') {
    const sheets = getSheetsClient();
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!A2:I`
        });

        const rows = response.data.values || [];
        return rows
            .map((r, index) => ({
                rowIndex: index + 2,
                date: r[0] || '',
                amountOriginal: parseNumber(r[1]),
                currency: r[2] || '',
                rate: parseNumber(r[3]),
                amountGel: parseNumber(r[4]),
                taxGel: parseNumber(r[5]),
                paymentDate: r[6] || '',
                description: r[7] || '',
                status: r[8] || ''
            }))
            .filter((record) => record.date || record.amountOriginal || record.amountGel || record.status);
    } catch (error) {
        if (sheetName === 'Лист1' && error.message.includes('Unable to parse range')) {
            return getAllRecords('Sheet1');
        }
        throw error;
    }
}

/**
 * Добавить запись о доходе (с проверкой на дубликаты)
 * @param {Object} record - { date, amountOriginal, currency, rate, amountGel, taxGel, paymentDate, description, status }
 * @returns {Promise<{added: boolean, message: string}>}
 */
async function addIncomeRecord(record, sheetName = 'Лист1') {
    await initSheetHeaders(sheetName);
    const existing = await getAllRecords(sheetName);

    // Проверка дубликата по дате, сумме в валюте и валюте
    const isDuplicate = existing.some(item =>
        item.date === record.date &&
        Math.abs(item.amountOriginal - record.amountOriginal) < 0.001 &&
        item.currency.toUpperCase() === record.currency.toUpperCase()
    );

    if (isDuplicate) {
        return {
            added: false,
            message: `Запись от ${record.date} на сумму ${record.amountOriginal} ${record.currency} уже есть в таблице.`
        };
    }

    const sheets = getSheetsClient();
    const newRow = [
        record.date,
        record.amountOriginal,
        record.currency.toUpperCase(),
        record.rate,
        record.amountGel,
        record.taxGel,
        record.paymentDate || '',
        record.description || 'Банковский перевод',
        record.status || 'Ожидает подачи'
    ];

    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:I`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [newRow]
        }
    });

    return {
        added: true,
        message: `Запись успешно добавлена: ${record.date} — ${record.amountOriginal} ${record.currency} (${record.amountGel} GEL).`
    };
}

/**
 * Получить доходы и расчет налога за указанный месяц и год
 * @param {number} year - например 2026
 * @param {number} month - 1-12
 */
async function getMonthlySummary(year, month, sheetName = 'Лист1') {
    const all = await getAllRecords(sheetName);
    const monthRecords = all.filter(r => {
        const period = parseRecordPeriod(r.date);
        return period && period.year === year && period.month === month;
    });

    const totalIncomeGel = monthRecords.reduce((sum, r) => sum + r.amountGel, 0);
    const totalTaxGel = monthRecords.reduce((sum, r) => sum + r.taxGel, 0);
    const statuses = [...new Set(monthRecords.map((record) => record.status.trim()).filter(Boolean))];
    const paymentDates = monthRecords.map((record) => record.paymentDate.trim()).filter(Boolean);
    const normalizedRecordStatuses = monthRecords.map((record) =>
        record.status.trim().toLocaleLowerCase('ru-RU')
    );
    const isFiled = monthRecords.length > 0 && normalizedRecordStatuses.every((status) =>
        status === 'подана' || status === 'sent' || status === 'გაგზავნილი'
    );

    return {
        year,
        month,
        recordsCount: monthRecords.length,
        records: monthRecords,
        totalIncomeGel: Number(totalIncomeGel.toFixed(2)),
        totalTaxGel: Number(totalTaxGel.toFixed(2)),
        paymentDate: paymentDates.at(-1) || '',
        paymentDates,
        isPaid: paymentDates.length > 0,
        isFiled,
        status: monthRecords.length === 0
            ? 'Нет записей'
            : (statuses.join(', ') || 'Ожидает подачи')
    };
}

/**
 * Получить нарастающий итог с начала года по указанный месяц включительно.
 */
async function getYearlySummary(year, throughMonth = 12, sheetName = 'Лист1') {
    const all = await getAllRecords(sheetName);
    const records = all.filter((record) => {
        const period = parseRecordPeriod(record.date);
        return period && period.year === year && period.month <= throughMonth;
    });

    const totalIncomeGel = records.reduce((sum, record) => sum + record.amountGel, 0);
    const totalTaxGel = records.reduce((sum, record) => sum + record.taxGel, 0);

    return {
        year,
        throughMonth,
        recordsCount: records.length,
        records,
        totalIncomeGel: Number(totalIncomeGel.toFixed(2)),
        totalTaxGel: Number(totalTaxGel.toFixed(2))
    };
}

module.exports = {
    initSheetHeaders,
    getAllRecords,
    addIncomeRecord,
    getMonthlySummary,
    getYearlySummary,
    parseNumber,
    parseRecordPeriod
};
