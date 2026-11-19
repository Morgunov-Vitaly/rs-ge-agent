const payments = require('../services/payments');
const { parseRecordPeriod } = require('../domain/dates');
const { ACTION_RISKS } = require('../core/action-contract');
const { auditLog: defaultAuditLog } = require('../infrastructure/audit-log');

function getPaymentHistoryYears(records, currentYear = new Date().getFullYear()) {
    const years = new Set([currentYear]);
    for (const record of records) {
        for (const value of [
            record.date,
            record.paymentDate,
            record.rsPaymentDate,
            record.rsPostedDate
        ]) {
            const period = parseRecordPeriod(value);
            if (period && period.year >= 2016 && period.year <= currentYear) years.add(period.year);
        }
    }
    return [...years].sort((left, right) => left - right);
}

async function executePaymentReconciliation({
    recordsRepository,
    rsGeClient,
    auditLog = defaultAuditLog,
    currentYear = new Date().getFullYear()
}) {
    const startedAt = Date.now();
    await auditLog.record({
        action: 'small-business.reconcile-payments',
        risk: ACTION_RISKS.READ_ONLY,
        status: 'started'
    });

    try {
        const records = await recordsRepository.getAllRecords();
        const years = getPaymentHistoryYears(records, currentYear);
        const portalHistory = await rsGeClient.getPaymentHistory({ years });
        const reconciliation = payments.reconcilePayments(records, portalHistory.payments);
        const report = payments.formatPaymentReport(reconciliation, portalHistory);

        await auditLog.record({
            action: 'small-business.reconcile-payments',
            risk: ACTION_RISKS.READ_ONLY,
            status: 'completed',
            durationMs: Date.now() - startedAt,
            metadata: {
                years,
                sheetRecords: records.length,
                portalPayments: portalHistory.payments.length,
                portalCharges: portalHistory.charges.length,
                matched: reconciliation.matchedCount,
                warnings: reconciliation.warningCount,
                untrackedPortalPayments: reconciliation.untrackedPortalPayments.length
            }
        });

        return { records, years, portalHistory, reconciliation, report };
    } catch (error) {
        await auditLog.record({
            action: 'small-business.reconcile-payments',
            risk: ACTION_RISKS.READ_ONLY,
            status: 'failed',
            durationMs: Date.now() - startedAt,
            metadata: { errorCode: error.code || 'UNKNOWN', errorName: error.name }
        });
        throw error;
    }
}

module.exports = {
    executePaymentReconciliation,
    getPaymentHistoryYears
};
