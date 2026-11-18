# Contributing

The project handles tax obligations and irreversible government-portal operations. Correctness and safety take priority over feature count.

The project is licensed under `AGPL-3.0-only`. Before substantial external contributions are accepted, the project must activate the contributor agreement described in [CLA.md](CLA.md) by identifying the legal licensor and documenting the acceptance process. The current CLA is intentionally marked as a draft.

## Before changing behavior

1. Identify the official source for the rule or portal behavior.
2. Record the effective date and affected taxpayer profile.
3. Add a failing test that demonstrates the expected result.
4. Keep domain logic independent from Telegram, Playwright and storage adapters.
5. Classify every new action using `ACTION_RISKS`.

## Project boundaries

- `domain/` — deterministic rules and value parsing;
- `workflows/` — use cases over connector interfaces;
- `connectors/` — external systems and persistence adapters;
- `modules/` — manifests of user-visible capabilities;
- `infrastructure/` — audit, scheduling, queues and secret storage;
- `services/bot.js` — Telegram transport only;
- `services/playwright.js` — legacy RS.GE browser adapter implementation.

New business rules must not be added directly to Telegram handlers or Playwright selectors.

## Tests

Install dependencies and the browser once:

```bash
npm ci
npx playwright install chromium
```

Run the same checks as CI:

```bash
npm run check
npm test
```

Required test levels:

- unit tests for rules and reconciliation;
- contract tests for connector interfaces;
- sanitized fixtures for RS.GE responses/DOM;
- read-only browser smoke tests for critical portal flows.

Browser contract tests use only sanitized HTML from `test/fixtures/rsge/`. Never capture a production page and commit it without manually removing names, taxpayer IDs, payment references, account numbers, cookies and embedded scripts containing session data.

Tests and fixtures must not contain real TINs, names, bank references, cookies, passwords or Google document IDs.

## Adding an RS.GE action

1. Implement a workflow that accepts connector interfaces through dependency injection.
2. Register it in a module manifest with a risk class.
3. For non-read-only actions, implement preview and explicit confirmation.
4. Add an idempotency key for operations that can be submitted.
5. Capture a sanitized audit event and proof of completion.
6. Document whether the connector uses an official API, an exported document or browser automation.

## Pull request checklist

- [ ] Official source/evidence is linked where applicable.
- [ ] No secret or personal data is included.
- [ ] Risk class is correct.
- [ ] Tests cover success, failure and boundary cases.
- [ ] README/RFC status matches the implementation.
- [ ] No irreversible action can run without confirmation.
- [ ] The active contributor agreement has been accepted, when applicable.
