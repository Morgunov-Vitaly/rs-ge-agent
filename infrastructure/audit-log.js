const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const { ACTION_RISKS } = require('../core/action-contract');

const SENSITIVE_KEY = /password|secret|token|cookie|authorization|sms|credential|session|tin|taxpayer/i;

function sanitize(value, key = '') {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map((item) => sanitize(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([childKey, childValue]) => [
                childKey,
                sanitize(childValue, childKey)
            ])
        );
    }
    return value;
}

class JsonlAuditLog {
    constructor(filePath = config.runtime.auditLogPath) {
        this.filePath = filePath;
        this.ready = fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    }

    async record(event) {
        await this.ready;
        const entry = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            action: event.action,
            risk: event.risk || ACTION_RISKS.READ_ONLY,
            status: event.status || 'completed',
            durationMs: event.durationMs,
            metadata: sanitize(event.metadata || {})
        };
        await fs.promises.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        return entry;
    }
}

const auditLog = new JsonlAuditLog();

module.exports = {
    JsonlAuditLog,
    auditLog,
    sanitize
};
