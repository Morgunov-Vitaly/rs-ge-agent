# Security Policy

RS.GE Agent processes tax, identity and financial data. Treat every deployment as a high-sensitivity system.

## Reporting a vulnerability

Do not publish credentials, cookies, SMS codes, taxpayer identifiers, bank data, screenshots or session files in a public issue.

Use [GitHub private vulnerability reporting](https://github.com/Morgunov-Vitaly/rs-ge-agent/security/advisories/new). Never place sensitive evidence in a public issue.

## Secrets that must never be committed

- `.env`;
- `google-credentials.json`;
- `session_state.json`;
- Telegram bot tokens;
- RS.GE username/password or service-user credentials;
- screenshots and exported taxpayer documents;
- SQLite databases and CSV/XLSX ledger exports;
- `logs/`, including the audit log from a real deployment.

If any of these files are exposed, revoke/rotate the affected credential and invalidate the RS.GE session; removing the file from the latest commit is not sufficient.

## Runtime expectations

- Run one isolated data directory per taxpayer/account.
- Restrict filesystem access to the service user.
- Store secrets in a secret manager or encrypted volume for hosted deployments.
- Retain screenshots only while needed for the active Human-in-the-Loop step.
- Rotate operational logs by age and size, enforce a disk quota, and keep the audit log under a separate retention policy.
- Delete temporary screenshots automatically; preserve proof artifacts only by explicit policy in encrypted storage.
- Never log request headers, cookies, passwords or SMS codes.
- Back up financial records separately from ephemeral browser sessions.

## Action safety

All actions declare a risk class in `core/action-contract.js`:

- `READ_ONLY`;
- `DRAFT_WRITE`;
- `DATA_WRITE`;
- `IRREVERSIBLE`;

Only `READ_ONLY` actions may execute without explicit user confirmation. Write actions use preview, confirmation and idempotency; irreversible submission additionally verifies `Sent` and stores encrypted evidence. The payment link merely opens the official RS.GE page; the agent does not initiate a payment.

## Current limitations

- RS.GE credentials and browser session state are not yet encrypted by the application itself.
- The current runtime is single-user.
- Browser automation depends on the live RS.GE interface and must be treated as an untrusted external dependency.
- Evidence artifacts are encrypted with AES-256-GCM when final submission is enabled, but their separate retention policy is not yet implemented.
- The Web UI has local password authentication, signed sessions, CSRF protection and login rate limiting; it has no multi-user roles or public-hosting hardening.

Do not operate a public multi-tenant service until these limitations are addressed and a threat model has been reviewed.
