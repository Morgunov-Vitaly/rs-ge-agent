const MONTH_NAMES_RU = [
    'январь',
    'февраль',
    'март',
    'апрель',
    'май',
    'июнь',
    'июль',
    'август',
    'сентябрь',
    'октябрь',
    'ноябрь',
    'декабрь'
];

function getPreviousReportPeriod(now = new Date()) {
    let year = now.getFullYear();
    let month = now.getMonth();
    if (month < 1) {
        month = 12;
        year -= 1;
    }
    return { year, month };
}

function formatReportPeriod(year, month) {
    return `${String(month).padStart(2, '0')}.${year}`;
}

function getReportPeriodLabel(year, month) {
    return `${MONTH_NAMES_RU[month - 1]} ${year}`;
}

function isValidReportPeriod(year, month, now = new Date()) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        return false;
    }
    const earliestYear = now.getFullYear() - 5;
    const latest = getPreviousReportPeriod(now);
    if (year < earliestYear || year > latest.year) return false;
    if (year === latest.year && month > latest.month) return false;
    return true;
}

module.exports = {
    MONTH_NAMES_RU,
    getPreviousReportPeriod,
    formatReportPeriod,
    getReportPeriodLabel,
    isValidReportPeriod
};
