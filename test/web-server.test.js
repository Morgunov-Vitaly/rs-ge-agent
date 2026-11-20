const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../config');
const { hashPassword } = require('../web/security');
const { createWebApplication } = require('../web/server');
const { createSqliteIncomeRepository } = require('../connectors/sqlite/income-repository');

function extractCookie(response, name) {
    const setCookies = Array.isArray(response.headers['set-cookie'])
        ? response.headers['set-cookie']
        : [response.headers['set-cookie']].filter(Boolean);
    return setCookies
        .map((value) => value.split(';')[0])
        .find((value) => value.startsWith(`${name}=`));
}

function extractCsrf(html) {
    return html.match(/name="csrf" value="([^"]+)"/)?.[1];
}

function request(app, { method = 'GET', url = '/', cookie = '', body = '' } = {}) {
    return new Promise((resolve) => {
        const input = Readable.from(body ? [Buffer.from(String(body))] : []);
        input.method = method;
        input.url = url;
        input.socket = { remoteAddress: '127.0.0.1' };
        input.headers = cookie ? { cookie } : {};
        const headers = {};
        const chunks = [];
        const response = {
            headersSent: false,
            setHeader(name, value) {
                headers[name.toLowerCase()] = value;
            },
            writeHead(statusCode, nextHeaders = {}) {
                this.statusCode = statusCode;
                this.headersSent = true;
                for (const [name, value] of Object.entries(nextHeaders)) {
                    headers[name.toLowerCase()] = value;
                }
            },
            end(chunk) {
                if (chunk) chunks.push(Buffer.from(chunk));
                resolve({
                    status: this.statusCode || 200,
                    headers,
                    body: Buffer.concat(chunks).toString('utf8')
                });
            }
        };
        app.handler(input, response);
    });
}

test('web server protects dashboard, login, CSRF and session cookies', async () => {
    const passwordHash = await hashPassword('correct horse battery staple', 'server-test-salt');
    const appConfig = loadConfig({
        WEB_ENABLED: 'true',
        WEB_USERNAME: 'owner',
        WEB_PASSWORD_HASH: passwordHash,
        WEB_SESSION_SECRET: 'test-session-secret-that-is-long-enough',
        WEB_COOKIE_SECURE: 'false',
        GOOGLE_SPREADSHEET_ID: 'demo_sheet_123'
    });
    const addedRecords = [];
    const repository = {
        async getMonthlySummary(year, month) {
            return {
                year,
                month,
                recordsCount: month === 11 ? 0 : 1,
                totalIncomeGel: month === 11 ? 0 : 1000,
                totalTaxGel: month === 11 ? 0 : 10,
                status: month === 11 ? 'Ожидает подачи' : 'Подана',
                isFiled: month !== 11,
                isPaid: month !== 11
            };
        },
        async getYearlySummary() {
            return { totalIncomeGel: 5000 };
        },
        async getIncomeRecords() {
            return [{
                date: '2026-10-10',
                amountGel: 1000,
                taxGel: 10,
                paymentDate: '15.11.2026',
                status: 'Подана'
            }];
        },
        async getAllRecords() { return [...addedRecords]; },
        async addIncomeRecord(record) { addedRecords.push(record); return { added: true }; }
    };
    const app = createWebApplication({
        appConfig,
        recordsRepository: repository,
        convertToGel: async () => ({ rate: 2.7, amountGel: 270 }),
        appLogger: { error() {}, warn() {} },
        now: () => new Date('2026-11-19T12:00:00+04:00')
    });
    try {
        const protectedResponse = await request(app, { url: '/' });
        assert.equal(protectedResponse.status, 303);
        assert.equal(protectedResponse.headers.location, '/login');

        const loginPage = await request(app, { url: '/login' });
        const loginHtml = loginPage.body;
        const loginCsrf = extractCsrf(loginHtml);
        assert.ok(loginCsrf);
        assert.match(loginPage.headers['content-security-policy'], /frame-ancestors 'none'/);

        const rejectedLogin = await request(app, {
            method: 'POST',
            url: '/login',
            body: new URLSearchParams({ username: 'owner', password: 'wrong', csrf: loginCsrf })
        });
        assert.equal(rejectedLogin.status, 401);

        const refreshedLogin = await request(app, { url: '/login' });
        const refreshedHtml = refreshedLogin.body;
        const authenticated = await request(app, {
            method: 'POST',
            url: '/login',
            body: new URLSearchParams({
                username: 'owner',
                password: 'correct horse battery staple',
                csrf: extractCsrf(refreshedHtml)
            })
        });
        assert.equal(authenticated.status, 303);
        const sessionCookie = extractCookie(authenticated, 'rsge_session');
        assert.ok(sessionCookie);
        assert.match(authenticated.headers['set-cookie'], /HttpOnly/);
        assert.match(authenticated.headers['set-cookie'], /SameSite=Strict/);

        const dashboard = await request(app, {
            url: '/?year=2026&month=10',
            cookie: sessionCookie
        });
        const dashboardHtml = dashboard.body;
        assert.equal(dashboard.status, 200);
        assert.match(dashboardHtml, /Данные учета готовы к сверке/);
        assert.match(dashboardHtml, /1[\s\u00a0]000,00/);
        assert.match(dashboardHtml, /Подтверждение перед записью/);
        assert.match(dashboardHtml, /href="https:\/\/docs\.google\.com\/spreadsheets\/d\/demo_sheet_123\/edit"/);
        assert.match(dashboardHtml, /href="https:\/\/decl\.rs\.ge\/decls\.aspx"/);
        assert.match(dashboardHtml, /<span class="brand-mark"><svg/);
        const currentMonth = await request(app, {
            url: '/?year=2026&month=11', cookie: sessionCookie
        });
        assert.equal(currentMonth.status, 200);
        assert.match(currentMonth.body, /Доходы месяца накапливаются/);
        assert.doesNotMatch(currentMonth.body, /action="\/declarations"/);
        assert.doesNotMatch(currentMonth.body, /action="\/checks"/);

        const noCsrf = await request(app, {
            method: 'POST',
            url: '/checks',
            cookie: sessionCookie,
            body: new URLSearchParams({ year: '2026', month: '10' })
        });
        assert.equal(noCsrf.status, 403);

        const incomeForm = await request(app, { url: '/income', cookie: sessionCookie });
        assert.equal(incomeForm.status, 200);
        assert.match(incomeForm.body, /Добавить доход/);
        const incomePreview = await request(app, {
            method: 'POST', url: '/income/preview', cookie: sessionCookie,
            body: new URLSearchParams({
                csrf: extractCsrf(incomeForm.body), date: '2026-11-19', amount: '100',
                currency: 'USD', description: 'Контракт'
            })
        });
        assert.equal(incomePreview.status, 303);
        assert.equal(addedRecords.length, 0);
        const previewPage = await request(app, { url: '/income', cookie: sessionCookie });
        assert.match(previewPage.body, /270,00/);
        const token = previewPage.body.match(/name="token" value="([^"]+)"/)?.[1];
        assert.ok(token);
        const saved = await request(app, {
            method: 'POST', url: '/income/confirm', cookie: sessionCookie,
            body: new URLSearchParams({ csrf: extractCsrf(previewPage.body), token })
        });
        assert.equal(saved.status, 303);
        assert.equal(saved.headers.location, '/income?status=saved');
        const savedPage = await request(app, { url: '/income?status=saved', cookie: sessionCookie });
        assert.match(savedPage.body, /Доход записан/);
        assert.equal(addedRecords.length, 1);
        const replay = await request(app, {
            method: 'POST', url: '/income/confirm', cookie: sessionCookie,
            body: new URLSearchParams({ csrf: extractCsrf(previewPage.body), token })
        });
        assert.equal(replay.status, 409);
        assert.equal(addedRecords.length, 1);
    } finally {
        app.close();
    }
});

test('web ledger previews edits and deletion, protects filed periods and requires confirmation', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ge-web-ledger-'));
    const repository = createSqliteIncomeRepository({ filePath: path.join(directory, 'ledger.sqlite') });
    t.after(() => { repository.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const current = await repository.addIncomeRecord({
        date: '2026-11-18', amountOriginal: 100, currency: 'USD', rate: 2.7,
        amountGel: 270, taxGel: 2.7, description: 'Original', paymentDate: '', status: 'Ожидает подачи'
    });
    const filed = await repository.addIncomeRecord({
        date: '2026-10-18', amountOriginal: 10, currency: 'GEL', rate: 1,
        amountGel: 10, taxGel: 0.1, description: 'Filed', paymentDate: '2026-11-10', status: 'Подана'
    });
    const passwordHash = await hashPassword('ledger-secret', 'web-ledger-salt');
    const appConfig = loadConfig({
        STORAGE_DRIVER: 'sqlite', SQLITE_PATH: path.join(directory, 'ledger.sqlite'),
        WEB_ENABLED: 'true', WEB_USERNAME: 'owner', WEB_PASSWORD_HASH: passwordHash,
        WEB_SESSION_SECRET: 'ledger-test-session-secret-long-enough', WEB_COOKIE_SECURE: 'false'
    });
    const app = createWebApplication({ appConfig, recordsRepository: repository,
        convertToGel: async (value) => ({ rate: 2.7, amountGel: Number(value) * 2.7 }),
        appLogger: { error() {}, warn() {} }, now: () => new Date('2026-11-20T12:00:00+04:00') });
    t.after(() => app.close());
    const login = await request(app, { url: '/login' });
    const signedIn = await request(app, { method: 'POST', url: '/login',
        body: new URLSearchParams({ username: 'owner', password: 'ledger-secret', csrf: extractCsrf(login.body) }) });
    const cookie = extractCookie(signedIn, 'rsge_session');
    assert.ok(cookie);

    const ledger = await request(app, { url: '/ledger', cookie });
    assert.equal(ledger.status, 200);
    assert.match(ledger.body, /Original/);
    assert.match(ledger.body, /Filed/);
    assert.match(ledger.body, new RegExp(`/ledger/${current.id}/edit`));
    assert.doesNotMatch(ledger.body, new RegExp(`/ledger/${filed.id}/edit`));

    const locked = await request(app, { url: `/ledger/${filed.id}/delete`, cookie });
    assert.equal(locked.status, 409);
    const edit = await request(app, { url: `/ledger/${current.id}/edit`, cookie });
    assert.equal(edit.status, 200);
    const missingCsrf = await request(app, { method: 'POST', url: `/ledger/${current.id}/preview`, cookie,
        body: new URLSearchParams({ date: '2026-11-18', amount: '120', currency: 'USD', description: 'Corrected' }) });
    assert.equal(missingCsrf.status, 403);
    const previewRequest = await request(app, { method: 'POST', url: `/ledger/${current.id}/preview`, cookie,
        body: new URLSearchParams({ csrf: extractCsrf(edit.body), date: '2026-11-18',
            amount: '120', currency: 'USD', description: 'Corrected', paymentDate: '' }) });
    assert.equal(previewRequest.status, 303);
    assert.equal((await repository.getRecord(current.id)).amountGel, 270);
    const preview = await request(app, { url: `/ledger/${current.id}/preview`, cookie });
    assert.match(preview.body, /324,00/);
    const token = preview.body.match(/name="token" value="([^"]+)"/)?.[1];
    const saved = await request(app, { method: 'POST', url: `/ledger/${current.id}/confirm`, cookie,
        body: new URLSearchParams({ csrf: extractCsrf(preview.body), token }) });
    assert.equal(saved.status, 303);
    assert.equal((await repository.getRecord(current.id)).amountGel, 324);
    assert.equal((await repository.getRecord(current.id)).taxGel, 3.24);
    assert.equal((await request(app, { method: 'POST', url: `/ledger/${current.id}/confirm`, cookie,
        body: new URLSearchParams({ csrf: extractCsrf(preview.body), token }) })).status, 409);

    const deleteRequest = await request(app, { url: `/ledger/${current.id}/delete`, cookie });
    assert.equal(deleteRequest.status, 303);
    assert.ok(await repository.getRecord(current.id));
    const deletePreview = await request(app, { url: `/ledger/${current.id}/preview`, cookie });
    assert.match(deletePreview.body, /Удалить поступление/);
    const deleteToken = deletePreview.body.match(/name="token" value="([^"]+)"/)?.[1];
    const deleted = await request(app, { method: 'POST', url: `/ledger/${current.id}/confirm`, cookie,
        body: new URLSearchParams({ csrf: extractCsrf(deletePreview.body), token: deleteToken }) });
    assert.equal(deleted.status, 303);
    assert.equal(await repository.getRecord(current.id), null);
});
