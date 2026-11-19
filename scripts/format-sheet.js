const { formatAccountingSpreadsheet } = require('../services/sheet-layout');

formatAccountingSpreadsheet()
    .then((result) => {
        console.log('Google Sheets успешно отформатирована.');
        console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
        console.error(`Ошибка форматирования Google Sheets: ${error.message}`);
        process.exitCode = 1;
    });
