const test = require('node:test');
const assert = require('node:assert/strict');

const { ACTION_RISKS, executeModuleAction } = require('../core/action-contract');
const smallBusinessModule = require('../modules/small-business/manifest');
const {
    buildDeclarationDraftPreview,
    getDeclarationPreviewFingerprint,
    createDraftIdempotencyKey
} = require('../workflows/declaration-draft');

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

function summaries(overrides = {}) {
    return {
        summary: {
            recordsCount: 2,
            totalIncomeGel: 2000.5,
            totalTaxGel: 20.01,
            isFiled: false,
            ...overrides.summary
        },
        yearSummary: {
            totalIncomeGel: 12000.5,
            ...overrides.yearSummary
        }
    };
}

function savedDraft(preview) {
    return {
        exists: true,
        status: 'Сохранен',
        fields: { ...preview.fields },
        screenshotBuffer: Buffer.from('saved draft')
    };
}

test('builds declaration preview with explicit zero fields and annual-limit rate', () => {
    const normal = buildDeclarationDraftPreview({
        year: 2026,
        month: 10,
        ...summaries()
    });
    assert.equal(normal.risk, ACTION_RISKS.DRAFT_WRITE);
    assert.equal(normal.period, '10.2026');
    assert.deepEqual(normal.fields, {
        15: 12000.5,
        16: 1,
        17: 2000.5,
        18: 0,
        19: 0,
        20: 2000.5,
        21: 0,
        26: 20.01
    });

    const overLimit = buildDeclarationDraftPreview({
        year: 2026,
        month: 10,
        ...summaries({
            summary: { totalIncomeGel: 20000, totalTaxGel: 200 },
            yearSummary: { totalIncomeGel: 510000 }
        })
    });
    assert.equal(overLimit.fields[16], 3);
    assert.equal(overLimit.fields[26], 600);
    assert.equal(overLimit.warnings.length, 1);
});

test('creates a draft only through confirmed DRAFT_WRITE action and audits it', async () => {
    const data = summaries();
    const preview = buildDeclarationDraftPreview({ year: 2026, month: 10, ...data });
    const auditLog = createMemoryAuditLog();
    let createCalls = 0;
    const recordsRepository = {
        getMonthlySummary: async () => data.summary,
        getYearlySummary: async () => data.yearSummary
    };
    const rsGeClient = {
        openExistingSmallBusinessDraft: async () => ({ exists: false }),
        createSmallBusinessDraft: async (receivedPreview, { idempotencyKey }) => {
            createCalls += 1;
            assert.deepEqual(receivedPreview.fields, preview.fields);
            assert.equal(idempotencyKey, createDraftIdempotencyKey(preview));
            return savedDraft(preview);
        }
    };
    const input = {
        recordsRepository,
        rsGeClient,
        year: 2026,
        month: 10,
        previewFingerprint: getDeclarationPreviewFingerprint(preview),
        auditLog
    };
    const execution = {
        confirmed: true,
        idempotencyKey: createDraftIdempotencyKey(preview)
    };

    const result = await executeModuleAction(
        smallBusinessModule,
        'create-declaration-draft',
        input,
        execution
    );

    assert.equal(result.created, true);
    assert.equal(createCalls, 1);
    assert.deepEqual(auditLog.events.map(({ status }) => status), ['started', 'completed']);
    assert.ok(auditLog.events.every(({ risk }) => risk === ACTION_RISKS.DRAFT_WRITE));
});

test('rejects stale preview before touching RS.GE', async () => {
    const original = summaries();
    const preview = buildDeclarationDraftPreview({ year: 2026, month: 10, ...original });
    let rsCalls = 0;
    const auditLog = createMemoryAuditLog();

    await assert.rejects(
        executeModuleAction(
            smallBusinessModule,
            'create-declaration-draft',
            {
                recordsRepository: {
                    getMonthlySummary: async () => ({ ...original.summary, totalIncomeGel: 2100.5 }),
                    getYearlySummary: async () => ({ ...original.yearSummary, totalIncomeGel: 12100.5 })
                },
                rsGeClient: {
                    openExistingSmallBusinessDraft: async () => {
                        rsCalls += 1;
                        return { exists: false };
                    }
                },
                year: 2026,
                month: 10,
                previewFingerprint: getDeclarationPreviewFingerprint(preview),
                auditLog
            },
            {
                confirmed: true,
                idempotencyKey: createDraftIdempotencyKey(preview)
            }
        ),
        ({ code }) => code === 'DECLARATION_PREVIEW_STALE'
    );
    assert.equal(rsCalls, 0);
    assert.deepEqual(auditLog.events.map(({ status }) => status), ['started', 'failed']);
});

test('treats an identical existing draft as an idempotent replay', async () => {
    const data = summaries();
    const preview = buildDeclarationDraftPreview({ year: 2026, month: 10, ...data });
    const auditLog = createMemoryAuditLog();
    let createCalls = 0;
    const result = await executeModuleAction(
        smallBusinessModule,
        'create-declaration-draft',
        {
            recordsRepository: {
                getMonthlySummary: async () => data.summary,
                getYearlySummary: async () => data.yearSummary
            },
            rsGeClient: {
                openExistingSmallBusinessDraft: async () => savedDraft(preview),
                createSmallBusinessDraft: async () => {
                    createCalls += 1;
                }
            },
            year: 2026,
            month: 10,
            previewFingerprint: getDeclarationPreviewFingerprint(preview),
            auditLog
        },
        {
            confirmed: true,
            idempotencyKey: createDraftIdempotencyKey(preview)
        }
    );

    assert.equal(result.created, false);
    assert.equal(result.alreadyExists, true);
    assert.equal(createCalls, 0);
    assert.deepEqual(auditLog.events.map(({ status }) => status), ['started', 'idempotent-replay']);
});
