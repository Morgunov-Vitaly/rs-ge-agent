const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { config, assertConfig } = require('../config');
const { HEADERS, parseNumber } = require('./sheets');

const DATA_SHEET_NAME = 'Лист1';
const SUMMARY_SHEET_NAME = 'Сводка';
const SUMMARY_MARKER = 'Налоговый учет ИП в Грузии';
const NUMERIC_COLUMN_INDEXES = [1, 3, 4, 5, 13];

function rgb(hex) {
    const normalized = hex.replace('#', '');
    return {
        red: parseInt(normalized.slice(0, 2), 16) / 255,
        green: parseInt(normalized.slice(2, 4), 16) / 255,
        blue: parseInt(normalized.slice(4, 6), 16) / 255
    };
}

function quoteSheetName(name) {
    return `'${String(name).replace(/'/g, "''")}'`;
}

function assertAccountingHeaders(row) {
    for (let index = 0; index < HEADERS.length; index += 1) {
        if (String(row[index] || '').trim() !== HEADERS[index]) {
            const error = new Error(
                `Неожиданный заголовок в колонке ${index + 1}: ожидался «${HEADERS[index]}»`
            );
            error.code = 'SHEET_LAYOUT_HEADERS_CHANGED';
            throw error;
        }
    }
}

function normalizeNumericColumns(formattedRows, formulaRows, sheetName = DATA_SHEET_NAME) {
    if (!formattedRows.length) throw new Error('Журнал доходов пуст');
    assertAccountingHeaders(formattedRows[0]);
    const lastRow = Math.max(formattedRows.length, formulaRows.length);
    const data = [];

    for (const columnIndex of NUMERIC_COLUMN_INDEXES) {
        const values = [];
        for (let rowIndex = 1; rowIndex < lastRow; rowIndex += 1) {
            const formulaValue = formulaRows[rowIndex]?.[columnIndex];
            if (typeof formulaValue === 'string' && formulaValue.startsWith('=')) {
                const error = new Error(
                    `Колонка ${columnIndex + 1}, строка ${rowIndex + 1} содержит формулу; преобразование остановлено`
                );
                error.code = 'SHEET_LAYOUT_FORMULA_CONFLICT';
                throw error;
            }

            const displayed = formattedRows[rowIndex]?.[columnIndex];
            if (displayed === undefined || displayed === null || displayed === '') {
                values.push(['']);
                continue;
            }

            const numeric = parseNumber(displayed);
            if (!Number.isFinite(numeric)) {
                throw new Error(`Не удалось преобразовать ${sheetName}!${rowIndex + 1}:${columnIndex + 1}`);
            }
            if (columnIndex === 3 && (numeric <= 0 || numeric >= 100)) {
                const error = new Error(`Некорректный курс NBG в строке ${rowIndex + 1}: ${displayed}`);
                error.code = 'SHEET_LAYOUT_INVALID_RATE';
                throw error;
            }
            values.push([numeric]);
        }

        const columnLetter = String.fromCharCode(65 + columnIndex);
        data.push({
            range: `${quoteSheetName(sheetName)}!${columnLetter}2:${columnLetter}${lastRow}`,
            values
        });
    }

    return { data, lastRow };
}

function formulaSeparator(locale) {
    return /^ru(?:_|$)/i.test(locale || '') ? ';' : ',';
}

function buildSummaryValues(locale) {
    const separator = formulaSeparator(locale);
    const dataSheet = quoteSheetName(DATA_SHEET_NAME);
    const currentYearIncome = [
        `=SUMIFS(${dataSheet}!E2:E`,
        `${dataSheet}!A2:A`,
        `">="&DATE(YEAR(TODAY())${separator}1${separator}1)`,
        `${dataSheet}!A2:A`,
        `"<"&DATE(YEAR(TODAY())+1${separator}1${separator}1))`
    ].join(separator);
    const currentYearTax = currentYearIncome.replace('E2:E', 'F2:F');

    return [
        [SUMMARY_MARKER, ''],
        ['Итоги рассчитываются автоматически по журналу доходов', ''],
        ['', ''],
        ['Показатель', 'Значение'],
        ['Доход всего (GEL)', `=SUM(${dataSheet}!E2:E)`],
        ['Налог всего (GEL)', `=SUM(${dataSheet}!F2:F)`],
        ['Доход текущего года (GEL)', currentYearIncome],
        ['Налог текущего года (GEL)', currentYearTax],
        ['Записей дохода', `=COUNT(${dataSheet}!E2:E)`],
        ['Расхождений с RS.GE', (
            `=COUNTIF(${dataSheet}!K2:K${separator}"Расхождение*")` +
            `+COUNTIF(${dataSheet}!K2:K${separator}"Не найдено*")`
        )],
        ['Несопоставленных платежей RS.GE', (
            `=COUNTIF(${dataSheet}!J2:J${separator}"Платёж RS.GE")`
        )],
        ['Последняя сверка', `=MAX(${dataSheet}!P2:P)`]
    ];
}

function buildDataFormatRequests({
    sheetId,
    rowCount,
    tableEndRow,
    bandedRangeId,
    basicFilter,
    hasConditionalFormats
}) {
    const darkBlue = rgb('#1F4E78');
    const lightBlue = rgb('#EAF2F8');
    const white = rgb('#FFFFFF');
    const darkText = rgb('#1F2937');
    const requests = [
        {
            updateSheetProperties: {
                properties: {
                    sheetId,
                    gridProperties: { frozenRowCount: 1, hideGridlines: true },
                    tabColor: rgb('#A9C4DC')
                },
                fields: 'gridProperties.frozenRowCount,gridProperties.hideGridlines,tabColor'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 17 },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: darkBlue,
                        horizontalAlignment: 'CENTER',
                        verticalAlignment: 'MIDDLE',
                        wrapStrategy: 'WRAP',
                        textFormat: { bold: true, foregroundColor: white, fontFamily: 'Arial', fontSize: 10 }
                    }
                },
                fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: 17 },
                cell: {
                    userEnteredFormat: {
                        verticalAlignment: 'MIDDLE',
                        textFormat: { foregroundColor: darkText, fontFamily: 'Arial', fontSize: 10 }
                    }
                },
                fields: 'userEnteredFormat(verticalAlignment,textFormat)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: 1 },
                cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd.MM.yyyy' }, horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 1, endColumnIndex: 2 },
                cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' }, horizontalAlignment: 'RIGHT' } },
                fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 3, endColumnIndex: 4 },
                cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.0000' }, horizontalAlignment: 'RIGHT' } },
                fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 4, endColumnIndex: 6 },
                cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' }, horizontalAlignment: 'RIGHT' } },
                fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 6, endColumnIndex: 7 },
                cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd.MM.yyyy' }, horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 11, endColumnIndex: 13 },
                cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd.MM.yyyy' }, horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 13, endColumnIndex: 14 },
                cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' }, horizontalAlignment: 'RIGHT' } },
                fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 15, endColumnIndex: 16 },
                cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'dd.MM.yyyy HH:mm' }, horizontalAlignment: 'CENTER' } },
                fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
            }
        },
        {
            updateDimensionProperties: {
                range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
                properties: { pixelSize: 44 },
                fields: 'pixelSize'
            }
        }
    ];

    const widths = [100, 120, 75, 90, 115, 115, 105, 190, 135, 105, 155, 115, 115, 125, 175, 145, 320];
    widths.forEach((pixelSize, index) => requests.push({
        updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
            properties: { pixelSize },
            fields: 'pixelSize'
        }
    }));

    requests.push({
        setBasicFilter: {
            filter: {
                ...(basicFilter || {}),
                range: { sheetId, startRowIndex: 0, endRowIndex: tableEndRow, startColumnIndex: 0, endColumnIndex: 17 }
            }
        }
    });
    if (bandedRangeId) {
        requests.push({
            updateBanding: {
                bandedRange: {
                    bandedRangeId,
                    range: { sheetId, startRowIndex: 0, endRowIndex: tableEndRow, startColumnIndex: 0, endColumnIndex: 17 }
                },
                fields: 'range'
            }
        });
    } else {
        requests.push({
            addBanding: {
                bandedRange: {
                    range: { sheetId, startRowIndex: 0, endRowIndex: tableEndRow, startColumnIndex: 0, endColumnIndex: 17 },
                    rowProperties: {
                        headerColor: darkBlue,
                        firstBandColor: white,
                        secondBandColor: lightBlue
                    }
                }
            }
        });
    }
    if (!hasConditionalFormats) {
        const rules = [
            { text: 'Расхождение', color: '#FFF2CC', type: 'TEXT_CONTAINS' },
            { text: 'Не найдено в RS.GE', color: '#F4CCCC', type: 'TEXT_EQ' },
            { text: 'Только в RS.GE', color: '#D9EAF7', type: 'TEXT_EQ' }
        ];
        for (const rule of rules) {
            requests.push({
                addConditionalFormatRule: {
                    index: 0,
                    rule: {
                        ranges: [{ sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 10, endColumnIndex: 11 }],
                        booleanRule: {
                            condition: { type: rule.type, values: [{ userEnteredValue: rule.text }] },
                            format: { backgroundColor: rgb(rule.color) }
                        }
                    }
                }
            });
        }
    }
    return requests;
}

function buildSummaryFormatRequests(sheetId) {
    return [
        {
            updateSheetProperties: {
                properties: {
                    sheetId,
                    index: 0,
                    gridProperties: { hideGridlines: true },
                    tabColor: rgb('#1F4E78')
                },
                fields: 'index,gridProperties.hideGridlines,tabColor'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 12, startColumnIndex: 0, endColumnIndex: 2 },
                cell: { userEnteredFormat: { verticalAlignment: 'MIDDLE', textFormat: { fontFamily: 'Arial', fontSize: 10 } } },
                fields: 'userEnteredFormat(verticalAlignment,textFormat)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
                cell: { userEnteredFormat: { textFormat: { bold: true, fontFamily: 'Arial', fontSize: 14, foregroundColor: rgb('#1F2937') } } },
                fields: 'userEnteredFormat.textFormat'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 2 },
                cell: { userEnteredFormat: { textFormat: { italic: true, foregroundColor: rgb('#667085'), fontFamily: 'Arial', fontSize: 10 } } },
                fields: 'userEnteredFormat.textFormat'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 2 },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: rgb('#1F4E78'),
                        horizontalAlignment: 'CENTER',
                        textFormat: { bold: true, foregroundColor: rgb('#FFFFFF'), fontFamily: 'Arial', fontSize: 10 }
                    }
                },
                fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 4, endRowIndex: 8, startColumnIndex: 1, endColumnIndex: 2 },
                cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00' }, horizontalAlignment: 'RIGHT' } },
                fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 8, endRowIndex: 11, startColumnIndex: 1, endColumnIndex: 2 },
                cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0' }, horizontalAlignment: 'RIGHT' } },
                fields: 'userEnteredFormat(numberFormat,horizontalAlignment)'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 11, endRowIndex: 12, startColumnIndex: 1, endColumnIndex: 2 },
                cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'dd.MM.yyyy HH:mm' } } },
                fields: 'userEnteredFormat.numberFormat'
            }
        },
        {
            updateBorders: {
                range: { sheetId, startRowIndex: 3, endRowIndex: 12, startColumnIndex: 0, endColumnIndex: 2 },
                bottom: { style: 'SOLID', color: rgb('#D9E2F3') },
                innerHorizontal: { style: 'SOLID', color: rgb('#D9E2F3') }
            }
        },
        {
            updateDimensionProperties: {
                range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
                properties: { pixelSize: 300 },
                fields: 'pixelSize'
            }
        },
        {
            updateDimensionProperties: {
                range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
                properties: { pixelSize: 170 },
                fields: 'pixelSize'
            }
        }
    ];
}

async function getSheetsClient() {
    assertConfig(config, ['google']);
    const auth = new google.auth.GoogleAuth({
        keyFile: config.google.credentialsPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    return google.sheets({ version: 'v4', auth });
}

async function formatAccountingSpreadsheet(options = {}) {
    const sheets = await getSheetsClient();
    const spreadsheetId = config.google.spreadsheetId;
    const backupDir = options.backupDir || path.join(config.runtime.logsDir, 'sheet-backups');
    const metadata = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'properties(locale),sheets(properties(sheetId,title,index,gridProperties),basicFilter,bandedRanges(bandedRangeId),conditionalFormats)'
    });
    const dataSheet = metadata.data.sheets.find(({ properties }) => properties.title === DATA_SHEET_NAME);
    if (!dataSheet) throw new Error(`Лист «${DATA_SHEET_NAME}» не найден`);

    const range = `${quoteSheetName(DATA_SHEET_NAME)}!A1:Q`;
    const [formattedResponse, formulaResponse] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'FORMATTED_VALUE' }),
        sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'FORMULA' })
    ]);
    const formattedRows = formattedResponse.data.values || [];
    const formulaRows = formulaResponse.data.values || [];
    const normalized = normalizeNumericColumns(formattedRows, formulaRows);

    await fs.promises.mkdir(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `sheet-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fs.promises.writeFile(backupPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        spreadsheetId,
        sheetName: DATA_SHEET_NAME,
        formulaRows,
        formattedRows
    }, null, 2), { mode: 0o600 });

    let summarySheet = metadata.data.sheets.find(({ properties }) => (
        properties.title === SUMMARY_SHEET_NAME
    ));
    if (summarySheet) {
        const marker = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${quoteSheetName(SUMMARY_SHEET_NAME)}!A1`
        });
        if ((marker.data.values?.[0]?.[0] || '') !== SUMMARY_MARKER) {
            const error = new Error(`Лист «${SUMMARY_SHEET_NAME}» уже существует и не принадлежит боту`);
            error.code = 'SHEET_LAYOUT_SUMMARY_CONFLICT';
            throw error;
        }
    } else {
        const added = await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ addSheet: { properties: { title: SUMMARY_SHEET_NAME, index: 0 } } }] }
        });
        summarySheet = { properties: added.data.replies[0].addSheet.properties };
    }

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: normalized.data }
    });
    await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `${quoteSheetName(SUMMARY_SHEET_NAME)}!A1:B20`
    });
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${quoteSheetName(SUMMARY_SHEET_NAME)}!A1:B12`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: buildSummaryValues(metadata.data.properties.locale) }
    });

    const rowCount = Math.max(dataSheet.properties.gridProperties?.rowCount || 1000, normalized.lastRow);
    const requests = [
        ...buildDataFormatRequests({
            sheetId: dataSheet.properties.sheetId,
            rowCount,
            tableEndRow: normalized.lastRow,
            bandedRangeId: dataSheet.bandedRanges?.[0]?.bandedRangeId || null,
            basicFilter: dataSheet.basicFilter || null,
            hasConditionalFormats: Boolean(dataSheet.conditionalFormats?.length)
        }),
        ...buildSummaryFormatRequests(summarySheet.properties.sheetId)
    ];
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

    const [verification, summaryVerification] = await Promise.all([
        sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${quoteSheetName(DATA_SHEET_NAME)}!A1:Q${normalized.lastRow}`,
            valueRenderOption: 'UNFORMATTED_VALUE',
            dateTimeRenderOption: 'SERIAL_NUMBER'
        }),
        sheets.spreadsheets.get({
            spreadsheetId,
            ranges: [`${quoteSheetName(SUMMARY_SHEET_NAME)}!A1:B12`],
            includeGridData: true,
            fields: 'sheets(data.rowData.values(effectiveValue,formattedValue,userEnteredValue))'
        })
    ]);
    const errors = (summaryVerification.data.sheets?.[0]?.data?.[0]?.rowData || [])
        .flatMap((row) => row.values || [])
        .filter((cell) => cell.effectiveValue?.errorValue);
    if (errors.length) {
        const error = new Error(`В сводке обнаружены ошибки формул: ${errors.length}`);
        error.code = 'SHEET_LAYOUT_FORMULA_ERROR';
        throw error;
    }

    return {
        backupPath,
        convertedRows: normalized.lastRow - 1,
        summarySheet: SUMMARY_SHEET_NAME,
        verifiedRows: Math.max(0, (verification.data.values || []).length - 1)
    };
}

module.exports = {
    DATA_SHEET_NAME,
    SUMMARY_MARKER,
    SUMMARY_SHEET_NAME,
    assertAccountingHeaders,
    buildDataFormatRequests,
    buildSummaryValues,
    formatAccountingSpreadsheet,
    normalizeNumericColumns
};
