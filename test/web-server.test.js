const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');

const { loadConfig } = require('../config');
const { hashPassword } = require('../web/security');
const { createWebApplication } = require('../web/server');

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
        WEB_COOKIE_SECURE: 'false'
    });
    const repository = {
        async getMonthlySummary(year, month) {
            return {
                year,
                month,
                recordsCount: 1,
                totalIncomeGel: 1000,
                totalTaxGel: 10,
                status: 'Подана',
                isFiled: true,
                isPaid: true
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
        }
    };
    const app = createWebApplication({
        appConfig,
        recordsRepository: repository,
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
        assert.match(dashboardHtml, /Только чтение/);

        const noCsrf = await request(app, {
            method: 'POST',
            url: '/checks',
            cookie: sessionCookie,
            body: new URLSearchParams({ year: '2026', month: '10' })
        });
        assert.equal(noCsrf.status, 403);
    } finally {
        app.close();
    }
});
