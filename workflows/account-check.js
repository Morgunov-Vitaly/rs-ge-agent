const { executePeriodCheck } = require('./period-check');
const { buildPaymentReconciliationPreview } = require('./payment-reconciliation-sync');

function countReconciliationStatuses(reconciliation) {
    const counts = {
        matched: 0,
        dateMismatch: 0,
        amountMismatch: 0,
        missingOnPortal: 0
    };

    for (const item of reconciliation.results) {
        if (item.status === 'matched') counts.matched += 1;
        else if (item.status === 'date_mismatch') counts.dateMismatch += 1;
        else if (item.status === 'amount_mismatch') counts.amountMismatch += 1;
        else if (item.status === 'missing') counts.missingOnPortal += 1;
    }
    return counts;
}

function formatRussianCount(count, one, few, many) {
    const absolute = Math.abs(Number(count));
    const lastTwo = absolute % 100;
    const last = absolute % 10;
    const word = lastTwo >= 11 && lastTwo <= 14
        ? many
        : (last === 1 ? one : (last >= 2 && last <= 4 ? few : many));
    return `${count} ${word}`;
}

function buildAccountCheckReport(periodCheck, reconciliationPreview) {
    const reconciliation = periodCheck.reconciliation;
    const counts = countReconciliationStatuses(reconciliation);
    const untracked = reconciliation.untrackedPortalPayments.length;
    const unpaid = reconciliation.unpaidPeriods.length;
    const issueCount = (
        counts.dateMismatch +
        counts.amountMismatch +
        counts.missingOnPortal +
        untracked +
        unpaid
    );
    const needsReconciliation = (
        reconciliationPreview.summary.rowsToUpdate > 0 ||
        reconciliationPreview.summary.portalRowsToInsert > 0
    );
    const lines = [
        periodCheck.report.replace(/\n\nДанные на RS\.GE и в Google Sheets не изменялись\.$/, ''),
        '',
        'История оплат:',
        `• Совпадает: ${formatRussianCount(counts.matched, 'запись', 'записи', 'записей')}`,
        `• Расхождение даты: ${formatRussianCount(counts.dateMismatch, 'запись', 'записи', 'записей')}`,
        `• Расхождение суммы: ${formatRussianCount(counts.amountMismatch, 'запись', 'записи', 'записей')}`,
        `• Не найдено на RS.GE: ${formatRussianCount(counts.missingOnPortal, 'запись', 'записи', 'записей')}`,
        `• Без даты оплаты в таблице: ${formatRussianCount(unpaid, 'период', 'периода', 'периодов')}`,
        `• Только на RS.GE: ${formatRussianCount(untracked, 'платёж', 'платежа', 'платежей')}`
    ];

    if (issueCount === 0) {
        lines.push('', '✅ По истории оплат расхождений не найдено.');
    } else if (needsReconciliation) {
        lines.push(
            '',
            'Обнаружены новые или изменившиеся расхождения. Их можно записать в таблицу после отдельного подтверждения.'
        );
    } else {
        lines.push('', 'Расхождения уже отражены в Google Sheets; повторная запись не требуется.');
    }

    lines.push('', 'Проверка выполнена в режиме чтения. Данные не изменялись.');
    return {
        report: lines.join('\n'),
        issueCount,
        needsReconciliation,
        counts
    };
}

async function executeAccountCheck(options) {
    const periodCheck = await executePeriodCheck(options);
    const reconciliationPreview = buildPaymentReconciliationPreview({
        records: periodCheck.records,
        reconciliation: periodCheck.reconciliation
    });
    return {
        ...periodCheck,
        reconciliationPreview,
        ...buildAccountCheckReport(periodCheck, reconciliationPreview)
    };
}

module.exports = {
    buildAccountCheckReport,
    countReconciliationStatuses,
    formatRussianCount,
    executeAccountCheck
};
