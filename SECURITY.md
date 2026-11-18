# Security Policy

RS.GE Agent processes tax, identity and financial data. Treat every deployment as a high-sensitivity system.

## Reporting a vulnerability

Do not publish credentials, cookies, SMS codes, taxpayer identifiers, bank data, screenshots or session files in a public issue.

Until a dedicated security contact is configured, use the repository host's private vulnerability reporting feature. A public release must not be made before a private reporting channel is documented here.

## Secrets that must never be committed

- `.env`;
- `google-credentials.json`;
- `session_state.json`;
- Telegram bot tokens;
- RS.GE username/password or service-user credentials;
- screenshots and exported taxpayer documents;
- `logs/`, including the audit log from a real deployment.

If any of these files are exposed, revoke/rotate the affected credential and invalidate the RS.GE session; removing the file from the latest commit is not sufficient.

## Runtime expectations

- Run one isolated data directory per taxpayer/account.
- Restrict filesystem access to the service user.
- Store secrets in a secret manager or encrypted volume for hosted deployments.
- Retain screenshots only while needed for the active Human-in-the-Loop step.
- Never log request headers, cookies, passwords or SMS codes.
- Back up financial records separately from ephemeral browser sessions.

## Action safety

All actions declare a risk class in `core/action-contract.js`:

- `READ_ONLY`;
- `DRAFT_WRITE`;
- `IRREVERSIBLE`;
- `EXTERNAL_PAYMENT`.

Only `READ_ONLY` actions may execute without explicit user confirmation. Future write actions must implement preview, confirmation, idempotency and proof of completion before being registered in a module manifest.

## Current limitations

- RS.GE credentials and browser session state are not yet encrypted by the application itself.
- The current runtime is single-user.
- Browser automation depends on the live RS.GE interface and must be treated as an untrusted external dependency.

Do not operate a public multi-tenant service until these limitations are addressed and a threat model has been reviewed.
