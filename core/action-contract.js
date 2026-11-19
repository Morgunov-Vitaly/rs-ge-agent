const ACTION_RISKS = Object.freeze({
    READ_ONLY: 'READ_ONLY',
    DRAFT_WRITE: 'DRAFT_WRITE',
    IRREVERSIBLE: 'IRREVERSIBLE',
    EXTERNAL_PAYMENT: 'EXTERNAL_PAYMENT'
});

const VALID_RISKS = new Set(Object.values(ACTION_RISKS));

function validateAction(action) {
    if (!action || typeof action !== 'object') throw new Error('Action должен быть объектом');
    if (!/^[a-z][a-z0-9-]*$/.test(action.id || '')) {
        throw new Error(`Некорректный action id: ${action.id || '<empty>'}`);
    }
    if (!VALID_RISKS.has(action.risk)) {
        throw new Error(`Некорректный риск action ${action.id}: ${action.risk}`);
    }
    if (typeof action.handler !== 'function') {
        throw new Error(`Action ${action.id} не содержит handler`);
    }
    return Object.freeze({ ...action });
}

function defineModule(manifest) {
    if (!manifest || !/^[a-z][a-z0-9-]*$/.test(manifest.id || '')) {
        throw new Error('Module manifest должен содержать корректный id');
    }
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) {
        throw new Error(`Module ${manifest.id}: version должна соответствовать semver`);
    }

    const actions = (manifest.actions || []).map(validateAction);
    const ids = new Set(actions.map(({ id }) => id));
    if (ids.size !== actions.length) {
        throw new Error(`Module ${manifest.id}: action id должны быть уникальны`);
    }

    return Object.freeze({
        ...manifest,
        actions: Object.freeze(actions),
        capabilities: Object.freeze([...(manifest.capabilities || [])])
    });
}

function requiresConfirmation(risk) {
    return risk !== ACTION_RISKS.READ_ONLY;
}

async function executeModuleAction(manifest, actionId, input, execution = {}) {
    const action = manifest.actions.find(({ id }) => id === actionId);
    if (!action) {
        throw new Error(`Module ${manifest.id} не содержит action ${actionId}`);
    }

    if (requiresConfirmation(action.risk)) {
        if (execution.confirmed !== true) {
            const error = new Error(`Action ${manifest.id}.${actionId} требует явного подтверждения`);
            error.code = 'CONFIRMATION_REQUIRED';
            throw error;
        }
        if (!execution.idempotencyKey) {
            const error = new Error(`Action ${manifest.id}.${actionId} требует idempotency key`);
            error.code = 'IDEMPOTENCY_KEY_REQUIRED';
            throw error;
        }
    }

    return action.handler(input, Object.freeze({ ...execution }));
}

module.exports = {
    ACTION_RISKS,
    defineModule,
    validateAction,
    requiresConfirmation,
    executeModuleAction
};
