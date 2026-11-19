const { ACTION_RISKS } = require('../core/action-contract');
const { auditLog: defaultAuditLog } = require('../infrastructure/audit-log');
const { compareDeclarationWithSummaries } = require('./declaration-review');
const { getPaymentHistoryYears } = require('./payment-reconciliation');
const payments = require('../services/payments');

const MONEY_TOLERANCE_GEL = 0.02;

function formatMoney(value) {
    return `${Number(value || 0).toFixed(2)} GEL`;
}

function formatPeriod(year, month) {
    return `${String(month).padStart(2, '0')}.${year}`;
}

function findPeriodPaymentGroups(reconciliation, period) {
    return reconciliation.results.filter(({ periods }) => periods.includes(period));
}

function buildPeriodCheckReport(result) {
    const {
        period,
        verdict,
        summary,
        declaration,
        declarationComparison,
        periodPayments,
        portalHistory,
        paymentSatisfied,
        debtClear
    } = result;
    const headline = verdict === 'closed'
        ? `✅ Период ${period} закрыт`
        : (verdict === 'portal-closed-sheet-mismatch'
            ? `⚠️ Период ${period} закрыт на RS.GE, но таблица требует сверки`
            : `❌ Период ${period} требует внимания`);
    const lines = [headline, ''];

    if (declaration.exists) {
        lines.push(`Декларация RS.GE: ${declaration.status || 'статус неизвестен'}`);
        if (declaration.metadata?.submittedAt) {
            lines.push(`Дата подачи: ${declaration.metadata.submittedAt}`);
        }
        if (declaration.metadata?.registrationNumber) {
            lines.push(`Регистрационный №: ${declaration.metadata.registrationNumber}`);
        }
        lines.push(
            `Доход: RS.GE ${formatMoney(declaration.fields[20])} / таблица ${formatMoney(summary.totalIncomeGel)}`,
            `Налог: RS.GE ${formatMoney(declaration.fields[26])} / таблица ${formatMoney(summary.totalTaxGel)}`
        );
    } else {
        lines.push('Декларация RS.GE: не найдена');
    }

    lines.push('');
    if (summary.totalTaxGel <= MONEY_TOLERANCE_GEL) {
        lines.push('Оплата: не требуется (нулевой налог)');
    } else if (paymentSatisfied) {
        for (const item of periodPayments) {
            lines.push(
                `Оплата: подтверждена ${payments.formatDate(item.portalPayment.paymentDate)} — ` +
                `RS.GE ${formatMoney(item.portalPayment.amount)} / таблица ${formatMoney(item.expectedAmount)}, ` +
                `разница ${item.amountDelta > 0 ? '+' : ''}${item.amountDelta.toFixed(2)} GEL`
            );
        }
    } else if (periodPayments.length === 0) {
        lines.push('Оплата: в таблице нет даты оплаты или платеж не удалось связать с периодом');
    } else {
        lines.push('Оплата: платеж найден с расхождением или не найден на RS.GE');
    }

    if (portalHistory.balance) {
        lines.push(
            `Личная карточка: задолженность ${formatMoney(portalHistory.balance.debt)}, ` +
            `переплата ${formatMoney(portalHistory.balance.overpayment)}`
        );
    } else {
        lines.push('Личная карточка: итоговый баланс прочитать не удалось');
    }

    const sheetPayment = summary.isPaid
        ? `оплата отмечена ${summary.paymentDate || '(дата не указана)'}`
        : 'оплата не отмечена';
    lines.push(`Google Sheets: ${summary.status || 'статус не указан'}; ${sheetPayment}`);

    const warnings = [];
    if (!declaration.exists) {
        warnings.push(summary.isFiled
            ? 'Автоматическая проверка не нашла декларацию на RS.GE, хотя в Google Sheets она отмечена как поданная.'
            : 'Автоматическая проверка не нашла декларацию за выбранный период на RS.GE.');
    } else if (!declarationComparison.rsStatusIsSent) {
        warnings.push('Декларация на RS.GE не отправлена.');
    }
    if (!declarationComparison.valuesMatch && declaration.exists) {
        warnings.push('Суммы декларации не совпадают с Google Sheets.');
    }
    if (declaration.exists && declarationComparison.statusMismatch) {
        warnings.push('Статус подачи в Google Sheets не совпадает со статусом RS.GE.');
    }
    if (!paymentSatisfied) warnings.push('Оплата периода не подтверждена автоматической сверкой.');
    if (!debtClear) warnings.push('На личной карточке есть задолженность или баланс недоступен.');
    if (summary.totalTaxGel > MONEY_TOLERANCE_GEL && !summary.isPaid) {
        warnings.push('В Google Sheets не отмечена оплата.');
    }

    if (warnings.length) {
        lines.push('', 'Требует проверки:');
        for (const warning of warnings) lines.push(`• ${warning}`);
    }

    lines.push('', 'Данные на RS.GE и в Google Sheets не изменялись.');
    return lines.join('\n');
}

async function executePeriodCheck({
    recordsRepository,
    rsGeClient,
    year,
    month,
    auditLog = defaultAuditLog,
    currentYear = new Date().getFullYear()
}) {
    const startedAt = Date.now();
    await auditLog.record({
        action: 'small-business.check-period',
        risk: ACTION_RISKS.READ_ONLY,
        status: 'started',
        metadata: { year, month }
    });

    try {
        const [summary, yearSummary, records] = await Promise.all([
            recordsRepository.getMonthlySummary(year, month),
            recordsRepository.getYearlySummary(year, month),
            recordsRepository.getAllRecords()
        ]);
        // Both calls use the same browser page and must remain sequential.
        const declaration = await rsGeClient.openExistingSmallBusinessDraft(year, month);
        const years = getPaymentHistoryYears(records, currentYear);
        const portalHistory = await rsGeClient.getPaymentHistory({ years });
        const reconciliation = payments.reconcilePayments(records, portalHistory.payments);
        const period = formatPeriod(year, month);
        const periodPayments = findPeriodPaymentGroups(reconciliation, period);
        const declarationComparison = compareDeclarationWithSummaries(
            declaration,
            summary,
            yearSummary
        );
        const paymentSatisfied = summary.totalTaxGel <= MONEY_TOLERANCE_GEL || (
            periodPayments.length > 0 &&
            periodPayments.every(({ status }) => status === 'matched')
        );
        const debtClear = Boolean(portalHistory.balance) &&
            Number(portalHistory.balance.debt || 0) <= MONEY_TOLERANCE_GEL;
        const portalClosed = declarationComparison.rsStatusIsSent && paymentSatisfied && debtClear;
        const recordsConsistent = declarationComparison.valuesMatch &&
            !declarationComparison.statusMismatch &&
            (summary.totalTaxGel <= MONEY_TOLERANCE_GEL || (summary.isPaid && paymentSatisfied));
        const verdict = portalClosed
            ? (recordsConsistent ? 'closed' : 'portal-closed-sheet-mismatch')
            : 'attention';

        const result = {
            year,
            month,
            period,
            verdict,
            summary,
            yearSummary,
            declaration,
            declarationComparison,
            portalHistory,
            reconciliation,
            records,
            periodPayments,
            paymentSatisfied,
            debtClear,
            portalClosed,
            recordsConsistent
        };
        result.report = buildPeriodCheckReport(result);

        await auditLog.record({
            action: 'small-business.check-period',
            risk: ACTION_RISKS.READ_ONLY,
            status: 'completed',
            durationMs: Date.now() - startedAt,
            metadata: {
                year,
                month,
                verdict,
                declarationSent: declarationComparison.rsStatusIsSent,
                valuesMatch: declarationComparison.valuesMatch,
                paymentSatisfied,
                debtClear,
                matchedPaymentGroups: periodPayments.filter(({ status }) => status === 'matched').length
            }
        });

        return result;
    } catch (error) {
        await auditLog.record({
            action: 'small-business.check-period',
            risk: ACTION_RISKS.READ_ONLY,
            status: 'failed',
            durationMs: Date.now() - startedAt,
            metadata: { year, month, errorCode: error.code || 'UNKNOWN', errorName: error.name }
        });
        throw error;
    }
}

module.exports = {
    MONEY_TOLERANCE_GEL,
    buildPeriodCheckReport,
    executePeriodCheck,
    findPeriodPaymentGroups,
    formatPeriod
};
