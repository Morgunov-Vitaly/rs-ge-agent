const test = require('node:test');
const assert = require('node:assert/strict');

const { ACTION_RISKS, executeModuleAction } = require('../core/action-contract');
const smallBusinessModule = require('../modules/small-business/manifest');
const {
    buildDeclarationSubmissionPreview,
    createSubmissionIdempotencyKey,
    getSubmissionPreviewFingerprint
} = require('../workflows/declaration-submit');

function createMemoryAuditLog() {
    const events = [];
    return {
        events,
        async record(event) {
            events.push(event);
            return event;
        }
    };
}

function scenario() {
    const summary = {
        recordsCount: 2,
        totalIncomeGel: 2000.5,
        totalTaxGel: 20.01,
        isFiled: false
    };
    const yearSummary = { totalIncomeGel: 12000.5 };
    const fields = {
        15: 12000.5,
        16: 1,
        17: 2000.5,
        18: 0,
        19: 0,
        20: 2000.5,
        21: 0,
        26: 20.01
    };
    const draft = { exists: true, status: 'Сохранен', fields };
    return { summary, yearSummary, draft };
}

function executionFor(preview) {
    return {
        confirmed: true,
        idempotencyKey: createSubmissionIdempotencyKey(preview)
    };
}

test('submits only an unchanged confirmed draft and saves evidence', async () => {
    const data = scenario();
    const preview = buildDeclarationSubmissionPreview({
        year: 2026,
        month: 10,
        ...data
    });
    const auditLog = createMemoryAuditLog();
    let submitCalls = 0;
    let evidenceCalls = 0;
    const declaration = {
        ...data.draft,
        status: 'Sent',
        screenshotBuffer: Buffer.from('proof screenshot'),
        pdfBuffer: Buffer.from('proof pdf')
    };

    const result = await executeModuleAction(
        smallBusinessModule,
        'submit-declaration',
        {
            recordsRepository: {
                getMonthlySummary: async () => data.summary,
                getYearlySummary: async () => data.yearSummary
            },
            rsGeClient: {
                openExistingSmallBusinessDraft: async () => data.draft,
                submitSmallBusinessDeclaration: async (receivedPreview) => {
                    submitCalls += 1;
                    assert.deepEqual(receivedPreview.fields, preview.fields);
                    return declaration;
                }
            },
            year: 2026,
            month: 10,
            previewFingerprint: getSubmissionPreviewFingerprint(preview),
            submissionEnabled: true,
            evidenceStore: {
                async saveDeclarationSubmission(input) {
                    evidenceCalls += 1;
                    assert.equal(input.screenshotBuffer, declaration.screenshotBuffer);
                    assert.equal(input.pdfBuffer, declaration.pdfBuffer);
                    return {
                        artifacts: [{
                            type: 'pdf',
                            fileName: 'proof.pdf',
                            sha256: 'abc',
                            bytes: declaration.pdfBuffer.length
                        }]
                    };
                }
            },
            auditLog
        },
        executionFor(preview)
    );

    assert.equal(result.submitted, true);
    assert.equal(submitCalls, 1);
    assert.equal(evidenceCalls, 1);
    assert.deepEqual(auditLog.events.map(({ status }) => status), ['started', 'completed']);
    assert.ok(auditLog.events.every(({ risk }) => risk === ACTION_RISKS.IRREVERSIBLE));
});

test('blocks final submission by configuration before reading external data', async () => {
    const auditLog = createMemoryAuditLog();
    let repositoryCalls = 0;

    await assert.rejects(
        executeModuleAction(
            smallBusinessModule,
            'submit-declaration',
            {
                recordsRepository: {
                    getMonthlySummary: async () => {
                        repositoryCalls += 1;
                    }
                },
                year: 2026,
                month: 10,
                submissionEnabled: false,
                auditLog
            },
            { confirmed: true, idempotencyKey: 'disabled-operation' }
        ),
        ({ code }) => code === 'SUBMISSION_DISABLED'
    );

    assert.equal(repositoryCalls, 0);
    assert.deepEqual(auditLog.events.map(({ status }) => status), ['started', 'blocked']);
});

test('does not click submit when the confirmed preview is stale', async () => {
    const original = scenario();
    const preview = buildDeclarationSubmissionPreview({
        year: 2026,
        month: 10,
        ...original
    });
    const changed = scenario();
    changed.summary = { ...changed.summary, totalIncomeGel: 2100.5, totalTaxGel: 21.01 };
    changed.yearSummary = { totalIncomeGel: 12100.5 };
    changed.draft = {
        ...changed.draft,
        fields: {
            ...changed.draft.fields,
            15: 12100.5,
            17: 2100.5,
            20: 2100.5,
            26: 21.01
        }
    };
    let submitCalls = 0;

    await assert.rejects(
        executeModuleAction(
            smallBusinessModule,
            'submit-declaration',
            {
                recordsRepository: {
                    getMonthlySummary: async () => changed.summary,
                    getYearlySummary: async () => changed.yearSummary
                },
                rsGeClient: {
                    openExistingSmallBusinessDraft: async () => changed.draft,
                    submitSmallBusinessDeclaration: async () => {
                        submitCalls += 1;
                    }
                },
                year: 2026,
                month: 10,
                previewFingerprint: getSubmissionPreviewFingerprint(preview),
                submissionEnabled: true,
                evidenceStore: { assertReady: async () => true },
                auditLog: createMemoryAuditLog()
            },
            executionFor(preview)
        ),
        ({ code }) => code === 'DECLARATION_SUBMISSION_PREVIEW_STALE'
    );
    assert.equal(submitCalls, 0);
});

test('treats a verified Sent status as an idempotent replay', async () => {
    const data = scenario();
    const preview = buildDeclarationSubmissionPreview({ year: 2026, month: 10, ...data });
    let submitCalls = 0;
    const result = await executeModuleAction(
        smallBusinessModule,
        'submit-declaration',
        {
            recordsRepository: {
                getMonthlySummary: async () => data.summary,
                getYearlySummary: async () => data.yearSummary
            },
            rsGeClient: {
                openExistingSmallBusinessDraft: async () => ({ ...data.draft, status: 'Sent' }),
                submitSmallBusinessDeclaration: async () => {
                    submitCalls += 1;
                }
            },
            year: 2026,
            month: 10,
            previewFingerprint: getSubmissionPreviewFingerprint(preview),
            submissionEnabled: true,
            evidenceStore: { assertReady: async () => true },
            auditLog: createMemoryAuditLog()
        },
        executionFor(preview)
    );

    assert.equal(result.submitted, false);
    assert.equal(result.alreadySent, true);
    assert.equal(submitCalls, 0);
});

test('marks a Sent declaration with changed values as completed but unsafe to retry', async () => {
    const data = scenario();
    const preview = buildDeclarationSubmissionPreview({ year: 2026, month: 10, ...data });
    const auditLog = createMemoryAuditLog();

    await assert.rejects(
        executeModuleAction(
            smallBusinessModule,
            'submit-declaration',
            {
                recordsRepository: {
                    getMonthlySummary: async () => data.summary,
                    getYearlySummary: async () => data.yearSummary
                },
                rsGeClient: {
                    openExistingSmallBusinessDraft: async () => data.draft,
                    submitSmallBusinessDeclaration: async () => ({
                        ...data.draft,
                        status: 'Sent',
                        fields: { ...data.draft.fields, 26: 99 },
                        screenshotBuffer: Buffer.from('proof screenshot'),
                        pdfBuffer: Buffer.from('proof pdf')
                    })
                },
                year: 2026,
                month: 10,
                previewFingerprint: getSubmissionPreviewFingerprint(preview),
                submissionEnabled: true,
                evidenceStore: { assertReady: async () => true },
                auditLog
            },
            executionFor(preview)
        ),
        ({ code }) => code === 'SUBMISSION_SUCCEEDED_VERIFICATION_FAILED'
    );

    assert.deepEqual(
        auditLog.events.map(({ status }) => status),
        ['started', 'completed-verification-failed']
    );
});

test('reports evidence failure as a completed submission that must not be retried', async () => {
    const data = scenario();
    const preview = buildDeclarationSubmissionPreview({ year: 2026, month: 10, ...data });
    const auditLog = createMemoryAuditLog();

    await assert.rejects(
        executeModuleAction(
            smallBusinessModule,
            'submit-declaration',
            {
                recordsRepository: {
                    getMonthlySummary: async () => data.summary,
                    getYearlySummary: async () => data.yearSummary
                },
                rsGeClient: {
                    openExistingSmallBusinessDraft: async () => data.draft,
                    submitSmallBusinessDeclaration: async () => ({
                        ...data.draft,
                        status: 'Sent',
                        screenshotBuffer: Buffer.from('proof screenshot'),
                        pdfBuffer: Buffer.from('proof pdf')
                    })
                },
                year: 2026,
                month: 10,
                previewFingerprint: getSubmissionPreviewFingerprint(preview),
                submissionEnabled: true,
                evidenceStore: {
                    saveDeclarationSubmission: async () => {
                        throw new Error('disk unavailable');
                    }
                },
                auditLog
            },
            executionFor(preview)
        ),
        ({ code }) => code === 'SUBMISSION_SUCCEEDED_EVIDENCE_FAILED'
    );

    assert.deepEqual(
        auditLog.events.map(({ status }) => status),
        ['started', 'completed-evidence-failed']
    );
});
