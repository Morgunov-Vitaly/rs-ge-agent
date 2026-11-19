const crypto = require('crypto');
const { ACTION_RISKS } = require('../core/action-contract');
const { auditLog: defaultAuditLog } = require('../infrastructure/audit-log');
const { RECORD_TYPES } = require('../services/sheets');
const payments = require('../services/payments');
const { getPaymentHistoryYears } = require('./payment-reconciliation');

const RECONCILIATION_STATUSES = Object.freeze({
    matched: 'Совпадает',
    date_mismatch: 'Расхождение даты',
    amount_mismatch: 'Расхождение суммы',
    missing: 'Не найдено в RS.GE',
    portal_only: 'Только в RS.GE'
});

function formatReconciledAt(value = new Date()) {
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Asia/Tbilisi',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(value).replace(',', '');
}

const createPortalPaymentId = payments.createPortalPaymentId;

function formatReconciliationComment(item) {
    if (item.status === 'matched') {
        return `Дата и сумма совпадают; разница ${item.amountDelta.toFixed(2)} GEL`;
    }
    if (item.status === 'date_mismatch') {
        return (
            `Дата таблицы ${payments.formatDate(item.paymentDate)}, ` +
            `RS.GE ${payments.formatDate(item.portalPayment.paymentDate)}; ` +
            `разница ${item.dateDifferenceDays} дн.`
        );
    }
    if (item.status === 'amount_mismatch') {
        return (
            `Таблица ${item.expectedAmount.toFixed(2)} GEL, ` +
            `RS.GE ${item.portalPayment.amount.toFixed(2)} GEL; ` +
            `разница ${item.amountDelta > 0 ? '+' : ''}${item.amountDelta.toFixed(2)} GEL`
        );
    }
    return `Платёж по дате ${payments.formatDate(item.paymentDate)} не найден в RS.GE`;
}

function desiredUpdate(item, rowIndex, reconciledAt) {
    const portalPayment = item.portalPayment;
    return {
        rowIndex,
        recordType: RECORD_TYPES.INCOME,
        reconciliationStatus: RECONCILIATION_STATUSES[item.status],
        rsPaymentDate: portalPayment ? payments.formatDate(portalPayment.paymentDate) : '',
        rsPostedDate: portalPayment
            ? payments.formatDate(portalPayment.postedDate || portalPayment.effectiveDate)
            : '',
        rsPaymentAmount: portalPayment ? Number(portalPayment.amount) : null,
        rsPaymentId: portalPayment ? createPortalPaymentId(portalPayment) : '',
        reconciledAt,
        reconciliationComment: formatReconciliationComment(item)
    };
}

function desiredInsertion(payment, rowIndex, reconciledAt) {
    return {
        rowIndex,
        description: 'Несопоставленный платеж RS.GE',
        recordType: RECORD_TYPES.RS_GE_PAYMENT,
        reconciliationStatus: RECONCILIATION_STATUSES.portal_only,
        rsPaymentDate: payments.formatDate(payment.paymentDate),
        rsPostedDate: payments.formatDate(payment.postedDate || payment.effectiveDate),
        rsPaymentAmount: Number(payment.amount),
        rsPaymentId: createPortalPaymentId(payment),
        reconciledAt,
        reconciliationComment: 'Платёж RS.GE не сопоставлен со строками дохода'
    };
}

function fingerprintPreview(records, updates, inserts) {
    const currentState = records.map((record) => ({
        rowIndex: record.rowIndex,
        date: record.date || '',
        taxGel: Number(record.taxGel || 0),
        paymentDate: record.paymentDate || '',
        recordType: record.recordType || '',
        reconciliationStatus: record.reconciliationStatus || '',
        rsPaymentDate: record.rsPaymentDate || '',
        rsPostedDate: record.rsPostedDate || '',
        rsPaymentAmount: record.rsPaymentAmount,
        rsPaymentId: record.rsPaymentId || '',
        reconciliationComment: record.reconciliationComment || ''
    }));
    const stripTimestamp = (record) => {
        const { reconciledAt: _ignored, ...stable } = record;
        return stable;
    };
    return crypto.createHash('sha256').update(JSON.stringify({
        currentState,
        updates: updates.map(stripTimestamp),
        inserts: inserts.map(stripTimestamp)
    })).digest('hex');
}

function buildPaymentReconciliationPreview({ records, reconciliation, reconciledAt = formatReconciledAt() }) {
    const recordByRow = new Map(records.map((record) => [record.rowIndex, record]));
    const updates = reconciliation.results.flatMap((item) => (
        item.rowIndexes
            .filter((rowIndex) => recordByRow.has(rowIndex))
            .map((rowIndex) => desiredUpdate(item, rowIndex, reconciledAt))
    ));

    const existingPortalPaymentIds = new Set(
        records
            .filter((record) => record.recordType === RECORD_TYPES.RS_GE_PAYMENT)
            .map((record) => record.rsPaymentId)
            .filter(Boolean)
    );
    let nextRowIndex = Math.max(1, ...records.map(({ rowIndex }) => rowIndex || 1)) + 1;
    const inserts = [];
    let existingPortalRows = existingPortalPaymentIds.size;
    for (const payment of reconciliation.untrackedPortalPayments) {
        const paymentId = createPortalPaymentId(payment);
        if (existingPortalPaymentIds.has(paymentId)) {
            continue;
        }
        inserts.push(desiredInsertion(payment, nextRowIndex, reconciledAt));
        nextRowIndex += 1;
    }

    const groupCounts = {};
    for (const item of reconciliation.results) {
        groupCounts[item.status] = (groupCounts[item.status] || 0) + 1;
    }
    const fingerprint = fingerprintPreview(records, updates, inserts);

    return {
        risk: ACTION_RISKS.DATA_WRITE,
        fingerprint,
        idempotencyKey: `payment-reconciliation:${fingerprint}`,
        plan: { updates, inserts },
        summary: {
            groups: reconciliation.results.length,
            matched: groupCounts.matched || 0,
            dateMismatches: groupCounts.date_mismatch || 0,
            amountMismatches: groupCounts.amount_mismatch || 0,
            missingOnPortal: groupCounts.missing || 0,
            rowsToUpdate: updates.length,
            portalRowsToInsert: inserts.length,
            existingPortalRows
        }
    };
}

function formatPaymentReconciliationPreview(preview) {
    const { summary } = preview;
    const lines = [
        'PREVIEW синхронизации с Google Sheets',
        '',
        `Класс риска: ${preview.risk}`,
        `Точные совпадения: ${summary.matched}`,
        `Расхождения дат: ${summary.dateMismatches}`,
        `Расхождения сумм: ${summary.amountMismatches}`,
        `Не найдено на RS.GE: ${summary.missingOnPortal}`,
        `Строк таблицы будет дополнено: ${summary.rowsToUpdate}`,
        `Несопоставленных платежей будет добавлено: ${summary.portalRowsToInsert}`,
    ];
    if (summary.existingPortalRows) {
        lines.push(`Ранее добавленных платежей пропущено: ${summary.existingPortalRows}`);
    }
    lines.push(
        '',
        'Исходные колонки A–I не изменяются. Служебные платежи не участвуют в расчёте дохода и налога.',
        'Изменения будут записаны только после подтверждения.'
    );
    return lines.join('\n');
}

async function executePaymentReconciliationSync({
    recordsRepository,
    rsGeClient,
    previewFingerprint,
    auditLog = defaultAuditLog,
    currentYear = new Date().getFullYear()
}) {
    const startedAt = Date.now();
    await auditLog.record({
        action: 'small-business.sync-payment-reconciliation',
        risk: ACTION_RISKS.DATA_WRITE,
        status: 'started'
    });

    try {
        const records = await recordsRepository.getAllRecords();
        const years = getPaymentHistoryYears(records, currentYear);
        const portalHistory = await rsGeClient.getPaymentHistory({ years });
        const reconciliation = payments.reconcilePayments(records, portalHistory.payments);
        const preview = buildPaymentReconciliationPreview({ records, reconciliation });

        if (preview.fingerprint !== previewFingerprint) {
            const error = new Error(
                'Данные Google Sheets или RS.GE изменились после preview.'
            );
            error.code = 'PAYMENT_RECONCILIATION_STALE';
            error.refreshedPreview = preview;
            throw error;
        }

        const writeResult = await recordsRepository.applyPaymentReconciliationPlan(preview.plan);
        await auditLog.record({
            action: 'small-business.sync-payment-reconciliation',
            risk: ACTION_RISKS.DATA_WRITE,
            status: 'completed',
            durationMs: Date.now() - startedAt,
            metadata: {
                years,
                updatedRows: writeResult.updatedRows,
                insertedRows: writeResult.insertedRows,
                matched: preview.summary.matched,
                warnings: (
                    preview.summary.dateMismatches +
                    preview.summary.amountMismatches +
                    preview.summary.missingOnPortal
                )
            }
        });

        return { preview, writeResult };
    } catch (error) {
        await auditLog.record({
            action: 'small-business.sync-payment-reconciliation',
            risk: ACTION_RISKS.DATA_WRITE,
            status: 'failed',
            durationMs: Date.now() - startedAt,
            metadata: { errorCode: error.code || 'UNKNOWN', errorName: error.name }
        });
        throw error;
    }
}

module.exports = {
    RECONCILIATION_STATUSES,
    buildPaymentReconciliationPreview,
    createPortalPaymentId,
    executePaymentReconciliationSync,
    formatPaymentReconciliationPreview,
    formatReconciledAt
};
