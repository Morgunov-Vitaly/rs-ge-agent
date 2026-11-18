const sheets = require('../../services/sheets');

function createGoogleSheetsIncomeRepository(sheetName = 'Лист1') {
    return Object.freeze({
        getAllRecords: () => sheets.getAllRecords(sheetName),
        getMonthlySummary: (year, month) => sheets.getMonthlySummary(year, month, sheetName),
        getYearlySummary: (year, throughMonth) => sheets.getYearlySummary(year, throughMonth, sheetName),
        addIncomeRecord: (record) => sheets.addIncomeRecord(record, sheetName)
    });
}

module.exports = { createGoogleSheetsIncomeRepository };
