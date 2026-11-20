const { parseRecordPeriod } = require('../domain/dates');
const {
    formatReportPeriod,
    getReportPeriodLabel
} = require('../domain/reporting-period');

function roundMoney(value) {
    return Number(Number(value || 0).toFixed(2));
}

function buildHistory(records, now = new Date(), limit = 12) {
    const periods = new Map();
    for (const record of records) {
        const period = parseRecordPeriod(record.date);
        if (!period) continue;
        const key = formatReportPeriod(period.year, period.month);
        const current = periods.get(key) || {
            key,
            year: period.year,
            month: period.month,
            label: getReportPeriodLabel(period.year, period.month),
            recordsCount: 0,
            incomeGel: 0,
            taxGel: 0,
            isPaid: false,
            paymentDate: '',
            statuses: new Set()
        };
        current.recordsCount += 1;
        current.incomeGel += Number(record.amountGel || 0);
        current.taxGel += Number(record.taxGel || 0);
        if (record.paymentDate) {
            current.isPaid = true;
            current.paymentDate = record.paymentDate;
        }
        if (record.status) current.statuses.add(String(record.status).trim());
        periods.set(key, current);
    }

    const latest = { year: now.getFullYear(), month: now.getMonth() + 1 };
    return [...periods.values()]
        .filter((item) => (
            item.year < latest.year || (item.year === latest.year && item.month <= latest.month)
        ))
        .sort((left, right) => right.year - left.year || right.month - left.month)
        .slice(0, limit)
        .map((item) => ({
            ...item,
            incomeGel: roundMoney(item.incomeGel),
            taxGel: roundMoney(item.taxGel),
            status: [...item.statuses].filter(Boolean).join(', ') || 'Ожидает подачи',
            statuses: undefined
        }));
}

async function loadDashboard({ recordsRepository, year, month, now = new Date() }) {
    const [summary, yearSummary, records] = await Promise.all([
        recordsRepository.getMonthlySummary(year, month),
        recordsRepository.getYearlySummary(year, month),
        recordsRepository.getIncomeRecords()
    ]);
    return {
        period: {
            year,
            month,
            key: formatReportPeriod(year, month),
            label: getReportPeriodLabel(year, month)
        },
        summary,
        yearSummary,
        history: buildHistory(records, now)
    };
}

module.exports = { buildHistory, loadDashboard, roundMoney };
