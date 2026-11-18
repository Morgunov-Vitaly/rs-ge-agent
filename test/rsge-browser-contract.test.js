const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    detectLoginState,
    readSmallBusinessDraftPage,
    readPayerCardTable
} = require('../connectors/rsge/page-readers');
const { launchBrowser, parsePayerCardRows } = require('../services/playwright');

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'rsge');
let browser;

async function withFixture(name, callback) {
    const page = await browser.newPage();
    try {
        const html = await fs.promises.readFile(path.join(FIXTURES_DIR, name), 'utf8');
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        return await callback(page);
    } finally {
        await page.close();
    }
}

test.before(async () => {
    browser = await launchBrowser(true);
});

test.after(async () => {
    await browser?.close();
});

test('recognizes credentials, SMS and authenticated login states', async () => {
    await withFixture('login-credentials.html', async (page) => {
        assert.equal(await detectLoginState(page), 'credentials');
    });
    await withFixture('login-sms.html', async (page) => {
        assert.equal(await detectLoginState(page), 'sms');
    });
    const page = await browser.newPage();
    try {
        await page.setContent('<main>Authenticated fixture</main>');
        assert.equal(await detectLoginState(page), 'authenticated');
    } finally {
        await page.close();
    }
});

test('does not treat the hidden RS.GE template row as a declaration', async () => {
    await withFixture('declarations-empty.html', async (page) => {
        assert.deepEqual(
            await readSmallBusinessDraftPage(page, '10.2026'),
            { exists: false }
        );
    });
});

test('reads a visible saved declaration and its numeric fields', async () => {
    await withFixture('declarations-draft.html', async (page) => {
        const result = await readSmallBusinessDraftPage(page, '10.2026');
        assert.equal(result.exists, true);
        assert.equal(result.status, 'Сохранен');
        assert.equal(result.fields[15], 12000.5);
        assert.equal(result.fields[20], 2000.5);
        assert.equal(result.fields[26], 20.01);
        assert.ok(Buffer.isBuffer(result.screenshotBuffer));
        assert.ok(result.screenshotBuffer.length > 0);
    });
});

test('fails safely on an unexpected period or unknown declaration DOM', async () => {
    await withFixture('declarations-empty.html', async (page) => {
        await assert.rejects(
            readSmallBusinessDraftPage(page, '09.2026'),
            ({ code }) => code === 'RSGE_UNEXPECTED_PERIOD'
        );
    });

    const page = await browser.newPage();
    try {
        await page.setContent('<main>Unknown RS.GE markup</main>');
        await assert.rejects(
            readSmallBusinessDraftPage(page, '10.2026', { timeout: 100 }),
            ({ code }) => code === 'RSGE_PAGE_CONTRACT_CHANGED'
        );
    } finally {
        await page.close();
    }
});

test('reads and parses sanitized payer-card rows', async () => {
    await withFixture('payer-card.html', async (page) => {
        const rows = await readPayerCardTable(page);
        const parsed = parsePayerCardRows(rows);

        assert.equal(parsed.payments.length, 1);
        assert.equal(parsed.payments[0].paymentDate, '2026-11-17');
        assert.equal(parsed.payments[0].amount, 73);
        assert.equal(parsed.charges.length, 1);
        assert.equal(parsed.charges[0].amount, 72.78);
        assert.deepEqual(parsed.balance, { debt: 0, overpayment: 5.5 });
    });
});
