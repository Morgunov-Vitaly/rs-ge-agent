/**
 * Сверка дат оплаты из Google Sheets с платежами в личной карточке RS.GE.
 *
 * RS.GE проводит банковский платеж на следующий рабочий день и обычно
 * принимает целую сумму в GEL. Поэтому дата платежного поручения берется из
 * описания операции, а разница до 1 GEL считается допустимым округлением и
 * обязательно показывается пользователю.
 */

const { parseRecordPeriod } = require('../domain/dates');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ROUNDING_TOLERANCE_GEL = 1;
const NEAR_DATE_TOLERANCE_DAYS = 3;

function toIsoDate(value) {
    const parsed = parseRecordPeriod(value);
    if (!parsed) return '';

    return [
        parsed.year,
        String(parsed.month).padStart(2, '0'),
        String(parsed.day).padStart(2, '0')
    ].join('-');
}

function formatDate(isoDate) {
    const parsed = parseRecordPeriod(isoDate);
    if (!parsed) return isoDate || 'дата не указана';
    return `${String(parsed.day).padStart(2, '0')}.${String(parsed.month).padStart(2, '0')}.${parsed.year}`;
}

function dateDiffDays(left, right) {
    const leftDate = parseRecordPeriod(left);
    const rightDate = parseRecordPeriod(right);
    if (!leftDate || !rightDate) return Number.POSITIVE_INFINITY;
    return Math.round(Math.abs(leftDate.date.getTime() - rightDate.date.getTime()) / ONE_DAY_MS);
}

function getRecordPeriod(record) {
    const period = parseRecordPeriod(record.date);
    if (!period) return '';
    return `${String(period.month).padStart(2, '0')}.${period.year}`;
}

/**
 * Группирует налог по одной дате оплаты. Это важно, когда одним банковским
 * поручением оплачены сразу несколько отчетных месяцев.
 */
function groupSheetPayments(records) {
    const groups = new Map();

    for (const record of records) {
        const paymentDate = toIsoDate(record.paymentDate);
        if (!paymentDate || Number(record.taxGel) <= 0) continue;

        if (!groups.has(paymentDate)) {
            groups.set(paymentDate, {
                paymentDate,
                expectedAmount: 0,
                periods: new Set(),
                rowIndexes: []
            });
        }

        const group = groups.get(paymentDate);
        group.expectedAmount += Number(record.taxGel) || 0;
        const period = getRecordPeriod(record);
        if (period) group.periods.add(period);
        if (record.rowIndex) group.rowIndexes.push(record.rowIndex);
    }

    return [...groups.values()]
        .map((group) => ({
            ...group,
            expectedAmount: Number(group.expectedAmount.toFixed(2)),
            periods: [...group.periods].sort()
        }))
        .sort((left, right) => left.paymentDate.localeCompare(right.paymentDate));
}

function findUnpaidPeriods(records) {
    const periods = new Map();

    for (const record of records) {
        const period = getRecordPeriod(record);
        if (!period || Number(record.taxGel) <= 0) continue;

        if (!periods.has(period)) {
            periods.set(period, { period, tax: 0, hasPaymentDate: false });
        }

        const summary = periods.get(period);
        summary.tax += Number(record.taxGel) || 0;
        summary.hasPaymentDate ||= Boolean(toIsoDate(record.paymentDate));
    }

    return [...periods.values()]
        .filter((summary) => !summary.hasPaymentDate)
        .map((summary) => ({
            period: summary.period,
            tax: Number(summary.tax.toFixed(2))
        }))
        .sort((left, right) => left.period.localeCompare(right.period));
}

function amountDifference(sheetGroup, portalPayment) {
    return Number((Number(portalPayment.amount) - sheetGroup.expectedAmount).toFixed(2));
}

function selectBestPayment(group, payments, usedIndexes, predicate) {
    return payments
        .map((payment, index) => ({
            payment,
            index,
            days: dateDiffDays(group.paymentDate, payment.paymentDate),
            amountDelta: amountDifference(group, payment)
        }))
        .filter((candidate) => !usedIndexes.has(candidate.index) && predicate(candidate))
        .sort((left, right) => {
            if (left.days !== right.days) return left.days - right.days;
            return Math.abs(left.amountDelta) - Math.abs(right.amountDelta);
        })[0] || null;
}

function reconcilePayments(records, portalPayments) {
    const sheetGroups = groupSheetPayments(records);
    const normalizedPortalPayments = portalPayments
        .filter((payment) => payment.paymentDate && Number(payment.amount) > 0)
        .map((payment) => ({ ...payment, amount: Number(payment.amount) }));
    const usedPortalIndexes = new Set();
    const results = [];

    for (const group of sheetGroups) {
        let candidate = selectBestPayment(
            group,
            normalizedPortalPayments,
            usedPortalIndexes,
            ({ days }) => days === 0
        );

        let status = 'missing';
        if (candidate) {
            status = Math.abs(candidate.amountDelta) <= ROUNDING_TOLERANCE_GEL
                ? 'matched'
                : 'amount_mismatch';
        } else {
            candidate = selectBestPayment(
                group,
                normalizedPortalPayments,
                usedPortalIndexes,
                ({ days, amountDelta }) => (
                    days <= NEAR_DATE_TOLERANCE_DAYS &&
                    Math.abs(amountDelta) <= ROUNDING_TOLERANCE_GEL
                )
            );
            if (candidate) status = 'date_mismatch';
        }

        if (candidate) usedPortalIndexes.add(candidate.index);
        results.push({
            ...group,
            status,
            portalPayment: candidate ? candidate.payment : null,
            amountDelta: candidate ? candidate.amountDelta : null,
            dateDifferenceDays: candidate ? candidate.days : null
        });
    }

    const untrackedPortalPayments = normalizedPortalPayments.filter(
        (_payment, index) => !usedPortalIndexes.has(index)
    );

    return {
        results,
        unpaidPeriods: findUnpaidPeriods(records),
        untrackedPortalPayments,
        matchedCount: results.filter(({ status }) => status === 'matched').length,
        warningCount: results.filter(({ status }) => status !== 'matched').length
    };
}

function formatAmountDelta(delta) {
    if (delta === null || delta === undefined) return '';
    const sign = delta > 0 ? '+' : '';
    return `${sign}${delta.toFixed(2)}`;
}

function formatPaymentReport(reconciliation, portalHistory) {
    const attentionCount = (
        reconciliation.warningCount +
        reconciliation.unpaidPeriods.length +
        reconciliation.untrackedPortalPayments.length
    );
    const lines = [
        '🔍 Сверка оплат: RS.GE ↔ Google Sheets',
        '',
        `Подтверждено: ${reconciliation.matchedCount}`,
        `Требует внимания: ${attentionCount}`
    ];

    for (const item of reconciliation.results) {
        const periodText = item.periods.length ? ` (${item.periods.join(', ')})` : '';
        if (!item.portalPayment) {
            lines.push(
                `❌ ${formatDate(item.paymentDate)}${periodText}: в таблице ${item.expectedAmount.toFixed(2)} GEL, платеж на RS.GE не найден`
            );
            continue;
        }

        const portalDate = formatDate(item.portalPayment.paymentDate);
        const amountText = `RS.GE ${item.portalPayment.amount.toFixed(2)} / таблица ${item.expectedAmount.toFixed(2)} GEL`;
        const deltaText = `разница ${formatAmountDelta(item.amountDelta)} GEL`;

        if (item.status === 'matched') {
            lines.push(`✅ ${portalDate}${periodText}: ${amountText}, ${deltaText}`);
        } else if (item.status === 'date_mismatch') {
            lines.push(
                `⚠️ Дата отличается: таблица ${formatDate(item.paymentDate)}, RS.GE ${portalDate}${periodText}; ${amountText}, ${deltaText}`
            );
        } else {
            lines.push(
                `⚠️ Сумма отличается ${formatDate(item.paymentDate)}${periodText}: ${amountText}, ${deltaText}`
            );
        }
    }

    for (const period of reconciliation.unpaidPeriods) {
        lines.push(`⚠️ ${period.period}: в таблице нет даты оплаты, налог ${period.tax.toFixed(2)} GEL`);
    }

    for (const payment of reconciliation.untrackedPortalPayments) {
        lines.push(
            `ℹ️ ${formatDate(payment.paymentDate)}: на RS.GE есть не сопоставленный платеж ${payment.amount.toFixed(2)} GEL`
        );
    }

    if (portalHistory && portalHistory.balance) {
        lines.push(
            '',
            `Текущий итог карточки RS.GE: задолженность ${portalHistory.balance.debt.toFixed(2)} GEL, ` +
            `переплата ${portalHistory.balance.overpayment.toFixed(2)} GEL.`
        );
    }

    lines.push('', 'Данные Google Sheets автоматически не изменялись.');
    return lines.join('\n');
}

module.exports = {
    groupSheetPayments,
    findUnpaidPeriods,
    reconcilePayments,
    formatPaymentReport,
    formatDate,
    toIsoDate,
    ROUNDING_TOLERANCE_GEL,
    NEAR_DATE_TOLERANCE_DAYS
};
