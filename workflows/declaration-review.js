const { ACTION_RISKS } = require('../core/action-contract');
const { auditLog: defaultAuditLog } = require('../infrastructure/audit-log');

function compareDeclarationWithSummaries(draft, summary, yearSummary) {
    if (!draft?.exists) {
        return {
            incomeMatches: false,
            taxMatches: false,
            cumulativeMatches: false,
            valuesMatch: false,
            rsStatusIsSent: false,
            statusMismatch: Boolean(summary?.isFiled)
        };
    }

    const incomeMatches = Math.abs(draft.fields[20] - summary.totalIncomeGel) <= 0.02;
    const taxMatches = Math.abs(draft.fields[26] - summary.totalTaxGel) <= 0.02;
    const cumulativeMatches = Math.abs(draft.fields[15] - yearSummary.totalIncomeGel) <= 0.02;
    const rsStatusIsSent = /sent|подан|გაგზავნილ|გადაგზავნილ/i.test(draft.status || '');

    return {
        incomeMatches,
        taxMatches,
        cumulativeMatches,
        valuesMatch: incomeMatches && taxMatches && cumulativeMatches,
        rsStatusIsSent,
        statusMismatch: Boolean(summary.isFiled) !== rsStatusIsSent
    };
}

async function executeDeclarationReview({
    recordsRepository,
    rsGeClient,
    year,
    month,
    auditLog = defaultAuditLog
}) {
    const startedAt = Date.now();
    await auditLog.record({
        action: 'small-business.review-declaration',
        risk: ACTION_RISKS.READ_ONLY,
        status: 'started',
        metadata: { year, month }
    });

    try {
        const [summary, yearSummary, draft] = await Promise.all([
            recordsRepository.getMonthlySummary(year, month),
            recordsRepository.getYearlySummary(year, month),
            rsGeClient.openExistingSmallBusinessDraft(year, month)
        ]);

        if (!draft.exists) {
            await auditLog.record({
                action: 'small-business.review-declaration',
                risk: ACTION_RISKS.READ_ONLY,
                status: 'not-found',
                durationMs: Date.now() - startedAt,
                metadata: { year, month }
            });
            return { summary, yearSummary, draft, exists: false };
        }

        const comparison = compareDeclarationWithSummaries(draft, summary, yearSummary);

        await auditLog.record({
            action: 'small-business.review-declaration',
            risk: ACTION_RISKS.READ_ONLY,
            status: 'completed',
            durationMs: Date.now() - startedAt,
            metadata: { year, month, ...comparison }
        });

        return { summary, yearSummary, draft, comparison, exists: true };
    } catch (error) {
        await auditLog.record({
            action: 'small-business.review-declaration',
            risk: ACTION_RISKS.READ_ONLY,
            status: 'failed',
            durationMs: Date.now() - startedAt,
            metadata: { year, month, errorCode: error.code || 'UNKNOWN', errorName: error.name }
        });
        throw error;
    }
}

module.exports = { compareDeclarationWithSummaries, executeDeclarationReview };
