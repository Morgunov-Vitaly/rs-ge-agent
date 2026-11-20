const { config } = require('../config');
const { createGoogleSheetsIncomeRepository } = require('./google-sheets/income-repository');
const { createSqliteIncomeRepository } = require('./sqlite/income-repository');

function createIncomeRepository({ appConfig = config } = {}) {
    if (appConfig.storage.driver === 'sheets') return createGoogleSheetsIncomeRepository();
    if (appConfig.storage.driver === 'sqlite') {
        return createSqliteIncomeRepository({ filePath: appConfig.storage.sqlitePath });
    }
    throw new Error(`Неизвестный STORAGE_DRIVER: ${appConfig.storage.driver}`);
}

module.exports = { createIncomeRepository };
