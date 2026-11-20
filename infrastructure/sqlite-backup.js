const fs = require('fs');
const path = require('path');
const { createSqliteIncomeRepository } = require('../connectors/sqlite/income-repository');

function backupDate(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);
}

async function createDailySqliteBackup({ filePath, now = new Date() }) {
    const directory = path.join(path.dirname(filePath), 'backups');
    const destination = path.join(directory, `rs-ge-${backupDate(now)}.sqlite`);
    if (fs.existsSync(destination)) return { destination, created: false };
    const temporary = `${destination}.partial`;
    const repository = createSqliteIncomeRepository({ filePath });
    try {
        await repository.backup(temporary);
        fs.renameSync(temporary, destination);
        return { destination, created: true };
    } finally {
        repository.close();
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

module.exports = { backupDate, createDailySqliteBackup };
