const sheets = require('../../services/sheets');

function createGoogleSheetsIncomeRepository(sheetName = 'Лист1') {
    return Object.freeze({
        driver: 'sheets',
        getAllRecords: () => sheets.getAllRecords(sheetName),
        getIncomeRecords: async () => (
            (await sheets.getAllRecords(sheetName)).filter(sheets.isIncomeRecord)
        ),
        getMonthlySummary: (year, month) => sheets.getMonthlySummary(year, month, sheetName),
        getYearlySummary: (year, throughMonth) => sheets.getYearlySummary(year, throughMonth, sheetName),
        addIncomeRecord: (record) => sheets.addIncomeRecord(record, sheetName),
        applyPaymentReconciliationPlan: (plan) => (
            sheets.applyPaymentReconciliationPlan(plan, sheetName)
        )
    });
}

module.exports = { createGoogleSheetsIncomeRepository };
