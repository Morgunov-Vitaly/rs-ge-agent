const fs = require('fs');
const http = require('http');
const path = require('path');

const { config: defaultConfig, assertConfig } = require('../config');
const { createGoogleSheetsIncomeRepository } = require('../connectors/google-sheets/income-repository');
const { createRsGeBrowserClient } = require('../connectors/rsge/browser-client');
const { getPreviousReportPeriod, isValidReportPeriod } = require('../domain/reporting-period');
const logger = require('../services/logger');
const playwright = require('../services/playwright');
const { executeAccountCheck } = require('../workflows/account-check');
const { loadDashboard } = require('./dashboard');
const { createOperationManager } = require('./operations');
const {
    createOneTimeTokenStore,
    createRateLimiter,
    createSessionStore,
    readForm,
    setSecurityHeaders,
    verifyPassword
} = require('./security');
const { dashboardView, errorView, loginView, operationView } = require('./views');

const ASSETS = Object.freeze({
    '/assets/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
    '/assets/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
    '/assets/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml; charset=utf-8' }
});

function send(response, statusCode, body, type = 'text/html; charset=utf-8', headers = {}) {
    response.writeHead(statusCode, { 'Content-Type': type, ...headers });
    response.end(body);
}

function redirect(response, location, headers = {}) {
    response.writeHead(303, { Location: location, ...headers });
    response.end();
}

function requestIp(request) {
    return request.socket.remoteAddress || 'unknown';
}

function parseRequestedPeriod(url, now) {
    const fallback = getPreviousReportPeriod(now);
    let year = Number(url.searchParams.get('year'));
    let month = Number(url.searchParams.get('month'));
    const compact = url.searchParams.get('period');
    if (compact && /^\d{4}-\d{1,2}$/.test(compact)) {
        [year, month] = compact.split('-').map(Number);
    }
    return isValidReportPeriod(year, month, now) ? { year, month } : fallback;
}

function createWebApplication({
    appConfig = defaultConfig,
    recordsRepository = createGoogleSheetsIncomeRepository(),
    loginToRsGe = playwright.loginToRsGe,
    createRsGeClient = createRsGeBrowserClient,
    accountCheck = executeAccountCheck,
    appLogger = logger,
    now = () => new Date()
} = {}) {
    assertConfig(appConfig, ['web']);
    const secureCookies = appConfig.web.secureCookies;
    const sessions = createSessionStore({
        secret: appConfig.web.sessionSecret,
        ttlMs: appConfig.web.sessionTtlMinutes * 60 * 1000,
        secureCookies
    });
    const loginLimiter = createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });
    const loginCsrfTokens = createOneTimeTokenStore({ ttlMs: 10 * 60 * 1000 });
    const operations = createOperationManager({
        loginToRsGe,
        createRsGeClient,
        executeAccountCheck: accountCheck,
        recordsRepository,
        logger: appLogger
    });
    const cleanupTimer = setInterval(() => {
        sessions.cleanup();
        loginCsrfTokens.cleanup();
        operations.cleanup();
    }, 5 * 60 * 1000);
    cleanupTimer.unref();

    async function handler(request, response) {
        setSecurityHeaders(response);
        const url = new URL(request.url, 'http://localhost');
        const asset = ASSETS[url.pathname];
        if (request.method === 'GET' && asset) {
            const content = await fs.promises.readFile(path.join(__dirname, 'public', asset.file));
            return send(response, 200, content, asset.type, { 'Cache-Control': 'public, max-age=3600' });
        }
        if (request.method === 'GET' && url.pathname === '/health') {
            return send(response, 200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8');
        }
        if (request.method === 'GET' && url.pathname === '/favicon.ico') {
            return redirect(response, '/assets/favicon.svg');
        }

        const session = sessions.get(request);
        if (request.method === 'GET' && url.pathname === '/login') {
            if (session) return redirect(response, '/');
            const csrfToken = loginCsrfTokens.create(requestIp(request));
            return send(response, 200, loginView({ csrfToken }));
        }

        if (request.method === 'POST' && url.pathname === '/login') {
            const rate = loginLimiter.consume(requestIp(request));
            if (!rate.allowed) {
                return send(response, 429, loginView({
                    csrfToken: '',
                    error: `Слишком много попыток. Повторите через ${rate.retryAfterSeconds} сек.`
                }), undefined, { 'Retry-After': String(rate.retryAfterSeconds) });
            }
            const form = await readForm(request);
            if (!loginCsrfTokens.consume(form.csrf, requestIp(request))) {
                const csrfToken = loginCsrfTokens.create(requestIp(request));
                return send(response, 403, loginView({
                    csrfToken,
                    error: 'Форма устарела. Повторите вход.'
                }));
            }
            const usernameMatches = form.username === appConfig.web.username;
            const passwordMatches = await verifyPassword(form.password, appConfig.web.passwordHash);
            if (!usernameMatches || !passwordMatches) {
                const csrfToken = loginCsrfTokens.create(requestIp(request));
                return send(response, 401, loginView({
                    csrfToken,
                    username: form.username,
                    error: 'Неверное имя пользователя или пароль.'
                }));
            }
            loginLimiter.reset(requestIp(request));
            const created = sessions.create(form.username);
            return redirect(response, '/', { 'Set-Cookie': created.cookie });
        }

        if (!session) return redirect(response, '/login');

        if (request.method === 'POST' && url.pathname === '/logout') {
            const form = await readForm(request);
            if (form.csrf !== session.csrfToken) {
                return send(response, 403, errorView({
                    session,
                    statusCode: 403,
                    title: 'Не удалось завершить сессию',
                    message: 'Обновите страницу и повторите выход.'
                }));
            }
            sessions.destroy(request);
            return redirect(response, '/login', { 'Set-Cookie': sessions.clearCookie });
        }

        if (request.method === 'GET' && url.pathname === '/') {
            const currentDate = now();
            const period = parseRequestedPeriod(url, currentDate);
            try {
                const dashboard = await loadDashboard({
                    recordsRepository,
                    year: period.year,
                    month: period.month,
                    now: currentDate
                });
                return send(response, 200, dashboardView({ session, dashboard, now: currentDate }));
            } catch (error) {
                appLogger.error('Web dashboard failed:', error);
                const fallback = {
                    period: { ...period, key: `${String(period.month).padStart(2, '0')}.${period.year}`, label: 'Выбранный период' },
                    summary: { recordsCount: 0, totalIncomeGel: 0, totalTaxGel: 0, status: 'Данные недоступны' },
                    yearSummary: { totalIncomeGel: 0 },
                    history: []
                };
                return send(response, 503, dashboardView({
                    session,
                    dashboard: fallback,
                    error: 'Не удалось прочитать Google Sheets. Проверьте подключение и повторите попытку.',
                    now: currentDate
                }));
            }
        }

        if (request.method === 'POST' && url.pathname === '/checks') {
            const form = await readForm(request);
            if (form.csrf !== session.csrfToken) {
                return send(response, 403, errorView({
                    session,
                    statusCode: 403,
                    title: 'Запрос отклонен',
                    message: 'Защитный токен устарел. Обновите страницу.'
                }));
            }
            const year = Number(form.year);
            const month = Number(form.month);
            if (!isValidReportPeriod(year, month, now())) {
                return send(response, 400, errorView({
                    session,
                    statusCode: 400,
                    title: 'Некорректный период',
                    message: 'Выберите доступный отчетный период.'
                }));
            }
            try {
                const operation = operations.start({ sessionId: session.id, year, month });
                return redirect(response, `/operations/${operation.id}`);
            } catch (error) {
                return send(response, 409, errorView({
                    session,
                    statusCode: 409,
                    title: 'Проверка уже выполняется',
                    message: 'Дождитесь завершения текущего входа в RS.GE.'
                }));
            }
        }

        const operationMatch = url.pathname.match(/^\/operations\/([a-f0-9-]+)$/i);
        if (request.method === 'GET' && operationMatch) {
            const operation = operations.get({ id: operationMatch[1], sessionId: session.id });
            if (!operation) {
                return send(response, 404, errorView({
                    session,
                    statusCode: 404,
                    title: 'Проверка не найдена',
                    message: 'Ссылка устарела или операция принадлежит другой сессии.'
                }));
            }
            return send(response, 200, operationView({ session, operation }));
        }

        const smsMatch = url.pathname.match(/^\/operations\/([a-f0-9-]+)\/sms$/i);
        if (request.method === 'POST' && smsMatch) {
            const form = await readForm(request);
            if (form.csrf !== session.csrfToken) {
                return send(response, 403, errorView({
                    session,
                    statusCode: 403,
                    title: 'Запрос отклонен',
                    message: 'Защитный токен устарел. Обновите страницу.'
                }));
            }
            const code = String(form.code || '').trim();
            if (!/^\d{4,8}$/.test(code)) {
                return send(response, 400, errorView({
                    session,
                    statusCode: 400,
                    title: 'Некорректный SMS-код',
                    message: 'Введите от 4 до 8 цифр из сообщения RS.GE.'
                }));
            }
            const accepted = operations.submitSms({
                id: smsMatch[1],
                sessionId: session.id,
                code
            });
            if (!accepted) {
                return send(response, 409, errorView({
                    session,
                    statusCode: 409,
                    title: 'Код больше не ожидается',
                    message: 'Проверка уже продолжилась или время ожидания истекло.'
                }));
            }
            return redirect(response, `/operations/${smsMatch[1]}`);
        }

        const apiMatch = url.pathname.match(/^\/api\/operations\/([a-f0-9-]+)$/i);
        if (request.method === 'GET' && apiMatch) {
            const operation = operations.get({ id: apiMatch[1], sessionId: session.id });
            if (!operation) return send(response, 404, JSON.stringify({ error: 'not_found' }), 'application/json; charset=utf-8');
            return send(response, 200, JSON.stringify({ status: operation.status }), 'application/json; charset=utf-8');
        }

        return send(response, 404, errorView({
            session,
            statusCode: 404,
            title: 'Страница не найдена',
            message: 'Проверьте адрес или вернитесь на главную.'
        }));
    }

    return {
        handler(request, response) {
            handler(request, response).catch((error) => {
                appLogger.error('Unhandled Web request error:', error);
                if (!response.headersSent) {
                    setSecurityHeaders(response);
                    send(response, error.code === 'BODY_TOO_LARGE' ? 413 : 500, 'Ошибка сервера', 'text/plain; charset=utf-8');
                } else {
                    response.end();
                }
            });
        },
        close() {
            clearInterval(cleanupTimer);
        }
    };
}

function startWebServer(options = {}) {
    const appConfig = options.appConfig || defaultConfig;
    const app = createWebApplication({ ...options, appConfig });
    const server = http.createServer(app.handler);
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(appConfig.web.port, appConfig.web.host, () => {
            server.off('error', reject);
            resolve({
                server,
                close: () => new Promise((closeResolve, closeReject) => {
                    app.close();
                    server.close((error) => error ? closeReject(error) : closeResolve());
                })
            });
        });
    });
}

module.exports = { createWebApplication, parseRequestedPeriod, startWebServer };
