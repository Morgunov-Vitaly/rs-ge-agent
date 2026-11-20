const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const { config: defaultConfig, assertConfig } = require('../config');
const { createIncomeRepository } = require('../connectors/income-repository');
const { createRsGeBrowserClient } = require('../connectors/rsge/browser-client');
const { getPreviousReportPeriod, isValidReportPeriod } = require('../domain/reporting-period');
const { parseRecordPeriod } = require('../domain/dates');
const { checkSubmissionPeriod } = require('../domain/small-business');
const { executeModuleAction } = require('../core/action-contract');
const smallBusinessModule = require('../modules/small-business/manifest');
const logger = require('../services/logger');
const nbg = require('../services/nbg');
const playwright = require('../services/playwright');
const { executeAccountCheck } = require('../workflows/account-check');
const { loadDashboard } = require('./dashboard');
const { createOperationManager } = require('./operations');
const { buildIncomePreview, incomeFingerprint, incomeIdempotencyKey } = require('../workflows/income-entry');
const { buildIncomeMaintenancePreview, previewFingerprint: maintenanceFingerprint,
    idempotencyKey: maintenanceIdempotencyKey } = require('../workflows/income-maintenance');
const { buildIncomeImportPreview, importFingerprint, importIdempotencyKey } = require('../workflows/income-import');
const { exportCsv, exportXlsx, parseImportFile } = require('./ledger-file');
const { readLedgerUpload } = require('./upload');
const {
    createOneTimeTokenStore,
    createRateLimiter,
    createSessionStore,
    readForm,
    setSecurityHeaders,
    verifyPassword
} = require('./security');
const { dashboardView, errorView, incomeView, ledgerEditView, ledgerImportView, ledgerPreviewView,
    ledgerView, loginView, operationView } = require('./views');

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
    const current = year === now.getFullYear() && month === now.getMonth() + 1;
    return current || isValidReportPeriod(year, month, now) ? { year, month } : fallback;
}

function createWebApplication({
    appConfig = defaultConfig,
    recordsRepository = null,
    loginToRsGe = playwright.loginToRsGe,
    createRsGeClient = createRsGeBrowserClient,
    accountCheck = executeAccountCheck,
    convertToGel = nbg.convertToGel,
    appLogger = logger,
    now = () => new Date()
} = {}) {
    assertConfig(appConfig, ['web']);
    const ownsRepository = !recordsRepository;
    recordsRepository ||= createIncomeRepository({ appConfig });
    const secureCookies = appConfig.web.secureCookies;
    const storageDriver = recordsRepository.driver || appConfig.storage.driver;
    const spreadsheetUrl = /^[A-Za-z0-9_-]+$/.test(appConfig.google.spreadsheetId)
        ? `https://docs.google.com/spreadsheets/d/${appConfig.google.spreadsheetId}/edit`
        : '';
    const sessions = createSessionStore({
        secret: appConfig.web.sessionSecret,
        ttlMs: appConfig.web.sessionTtlMinutes * 60 * 1000,
        secureCookies
    });
    const loginLimiter = createRateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });
    const loginCsrfTokens = createOneTimeTokenStore({ ttlMs: 10 * 60 * 1000 });
    const pendingIncome = new Map();
    const savedIncome = new Map();
    const pendingMaintenance = new Map();
    const pendingImport = new Map();
    let incomeWriteInProgress = false;
    const operations = createOperationManager({
        loginToRsGe,
        createRsGeClient,
        executeAccountCheck: accountCheck,
        recordsRepository,
        logger: appLogger,
        submissionEnabled: appConfig.rsGe.enableSubmission
    });
    const cleanupTimer = setInterval(() => {
        sessions.cleanup();
        loginCsrfTokens.cleanup();
        operations.cleanup();
        for (const [sessionId, item] of pendingIncome) {
            if (Date.now() - item.createdAt > 10 * 60 * 1000) pendingIncome.delete(sessionId);
        }
        for (const [sessionId, item] of savedIncome) {
            if (Date.now() - item.createdAt > 10 * 60 * 1000) savedIncome.delete(sessionId);
        }
        for (const [sessionId, item] of pendingMaintenance) {
            if (Date.now() - item.createdAt > 10 * 60 * 1000) pendingMaintenance.delete(sessionId);
        }
        for (const [sessionId, item] of pendingImport) {
            if (Date.now() - item.createdAt > 10 * 60 * 1000) pendingImport.delete(sessionId);
        }
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
            pendingIncome.delete(session.id);
            savedIncome.delete(session.id);
            pendingMaintenance.delete(session.id);
            pendingImport.delete(session.id);
            return redirect(response, '/login', { 'Set-Cookie': sessions.clearCookie });
        }

        if (request.method === 'GET' && url.pathname === '/income') {
            if (url.searchParams.get('status') === 'saved') {
                const saved = savedIncome.get(session.id);
                if (saved && Date.now() - saved.createdAt <= 10 * 60 * 1000) {
                    return send(response, 200, incomeView({ session, saved: saved.preview, now: now(), storageDriver }));
                }
                return redirect(response, '/income');
            }
            if (url.searchParams.get('edit') === '1') {
                const previous = pendingIncome.get(session.id);
                pendingIncome.delete(session.id);
                return send(response, 200, incomeView({ session, input: previous?.rawInput, now: now(), storageDriver }));
            }
            const pending = pendingIncome.get(session.id);
            const current = pending && Date.now() - pending.createdAt <= 10 * 60 * 1000 ? pending : null;
            if (!current) pendingIncome.delete(session.id);
            return send(response, 200, incomeView({ session, pending: current, now: now(), storageDriver }));
        }

        if (request.method === 'POST' && url.pathname === '/income/preview') {
            const form = await readForm(request);
            if (form.csrf !== session.csrfToken) return send(response, 403, errorView({ session, statusCode: 403, title: 'Запрос отклонен', message: 'Обновите страницу и повторите действие.' }));
            const rawInput = { date: form.date, amount: form.amount, currency: form.currency, description: form.description };
            try {
                const preview = await buildIncomePreview({ input: rawInput, convertToGel, recordsRepository, now: now() });
                pendingIncome.set(session.id, { rawInput, preview, token: crypto.randomBytes(24).toString('base64url'), createdAt: Date.now() });
                return redirect(response, '/income');
            } catch (error) {
                return send(response, 400, incomeView({ session, input: rawInput, error: error.message, now: now(), storageDriver }));
            }
        }

        if (request.method === 'POST' && url.pathname === '/income/confirm') {
            const form = await readForm(request);
            if (form.csrf !== session.csrfToken) return send(response, 403, errorView({ session, statusCode: 403, title: 'Запрос отклонен', message: 'Обновите страницу и повторите действие.' }));
            const pending = pendingIncome.get(session.id);
            if (!pending || Date.now() - pending.createdAt > 10 * 60 * 1000 || form.token !== pending.token) {
                pendingIncome.delete(session.id);
                return send(response, 409, incomeView({ session, error: 'Предпросмотр устарел. Введите данные заново.', now: now(), storageDriver }));
            }
            if (incomeWriteInProgress) {
                return send(response, 409, incomeView({ session, pending, error: 'Другая запись уже сохраняется. Повторите после ее завершения.', now: now(), storageDriver }));
            }
            pendingIncome.delete(session.id);
            incomeWriteInProgress = true;
            try {
                const result = await executeModuleAction(smallBusinessModule, 'add-income', {
                    recordsRepository, convertToGel, rawInput: pending.rawInput,
                    previewFingerprint: incomeFingerprint(pending.preview), now: now()
                }, { confirmed: true, idempotencyKey: incomeIdempotencyKey(pending.preview) });
                savedIncome.set(session.id, { preview: result.preview, createdAt: Date.now() });
                return redirect(response, '/income?status=saved');
            } catch (error) {
                return send(response, 409, incomeView({ session, input: pending.rawInput, error: error.message, now: now(), storageDriver }));
            } finally {
                incomeWriteInProgress = false;
            }
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
                return send(response, 200, dashboardView({ session, dashboard, now: currentDate, submissionEnabled: appConfig.rsGe.enableSubmission, spreadsheetUrl, storageDriver }));
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
                    error: 'Не удалось прочитать журнал учета. Проверьте хранилище и повторите попытку.',
                    now: currentDate,
                    submissionEnabled: appConfig.rsGe.enableSubmission,
                    spreadsheetUrl,
                    storageDriver
                }));
            }
        }

        if (request.method === 'GET' && url.pathname === '/ledger') {
            const allPeriods = !url.searchParams.has('period') || url.searchParams.get('period') === 'all';
            const selected = allPeriods ? null : parseRequestedPeriod(url, now());
            const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('page')) || 1));
            try {
                const records = await recordsRepository.getAllRecords();
                const filtered = records.filter((record) => {
                    if (allPeriods) return true;
                    const date = parseRecordPeriod(record.recordType === 'Платёж RS.GE'
                        ? record.rsPaymentDate : record.date);
                    return date?.year === selected.year && date.month === selected.month;
                }).sort((left, right) => {
                    const leftDate = parseRecordPeriod(left.date || left.rsPaymentDate)?.date.getTime() || 0;
                    const rightDate = parseRecordPeriod(right.date || right.rsPaymentDate)?.date.getTime() || 0;
                    return rightDate - leftDate || (right.id || right.rowIndex) - (left.id || left.rowIndex);
                });
                const incomeRecords = filtered.filter((record) => !record.recordType || record.recordType === 'Доход');
                const totals = {
                    incomeGel: incomeRecords.reduce((sum, record) => sum + Number(record.amountGel || 0), 0),
                    taxGel: incomeRecords.reduce((sum, record) => sum + Number(record.taxGel || 0), 0),
                    incomeCount: incomeRecords.length,
                    portalCount: filtered.length - incomeRecords.length
                };
                const totalPages = Math.max(1, Math.ceil(filtered.length / 50));
                const currentPage = Math.min(page, totalPages);
                const notice = url.searchParams.get('notice') === 'updated' ? 'Запись обновлена.'
                    : url.searchParams.get('notice') === 'deleted' ? 'Запись удалена из учета; история изменений сохранена.'
                        : url.searchParams.get('notice') === 'imported' ? 'Новые доходы импортированы в журнал.' : '';
                return send(response, 200, ledgerView({ session, rows: filtered.slice((currentPage - 1) * 50, currentPage * 50),
                    year: selected?.year, month: selected?.month, allPeriods, page: currentPage,
                    totalPages, totals, storageDriver, notice, now: now() }));
            } catch (error) {
                appLogger.error('Web ledger failed:', error);
                return send(response, 503, errorView({ session, statusCode: 503,
                    title: 'Журнал недоступен', message: 'Не удалось прочитать записи. Проверьте подключение к хранилищу.' }));
            }
        }

        if (request.method === 'GET' && /^\/ledger\/export\.(csv|xlsx)$/.test(url.pathname)) {
            const format = url.pathname.endsWith('.csv') ? 'csv' : 'xlsx';
            const allPeriods = !url.searchParams.has('period') || url.searchParams.get('period') === 'all';
            const selected = allPeriods ? null : parseRequestedPeriod(url, now());
            const records = (await recordsRepository.getAllRecords()).filter((record) => {
                if (allPeriods) return true;
                const date = parseRecordPeriod(record.recordType === 'Платёж RS.GE'
                    ? record.rsPaymentDate : record.date);
                return date?.year === selected.year && date.month === selected.month;
            });
            const body = format === 'csv' ? exportCsv(records) : await exportXlsx(records);
            const period = allPeriods ? 'all' : `${selected.year}-${String(selected.month).padStart(2, '0')}`;
            return send(response, 200, body,
                format === 'csv' ? 'text/csv; charset=utf-8'
                    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                { 'Content-Disposition': `attachment; filename="rs-ge-ledger-${period}.${format}"`,
                    'Cache-Control': 'private, no-store' });
        }

        if (url.pathname === '/ledger/import' && request.method === 'GET') {
            if (storageDriver !== 'sqlite') return send(response, 409, errorView({ session, statusCode: 409,
                title: 'Импорт недоступен', message: 'Для импорта включите локальный журнал SQLite.' }));
            const pending = pendingImport.get(session.id);
            return send(response, 200, ledgerImportView({ session,
                pending: pending && Date.now() - pending.createdAt <= 10 * 60 * 1000 ? pending : null }));
        }

        if (url.pathname === '/ledger/import/preview' && request.method === 'POST') {
            if (storageDriver !== 'sqlite') return send(response, 409, errorView({ session, statusCode: 409,
                title: 'Импорт недоступен', message: 'Для импорта включите локальный журнал SQLite.' }));
            try {
                const upload = await readLedgerUpload(request);
                if (upload.csrf !== session.csrfToken) return send(response, 403, errorView({ session,
                    statusCode: 403, title: 'Запрос отклонен', message: 'Обновите страницу и повторите действие.' }));
                const parsed = await parseImportFile(upload);
                const preview = await buildIncomeImportPreview({ parsed, recordsRepository,
                    convertToGel, now: now() });
                pendingImport.set(session.id, { parsed, preview,
                    filename: path.basename(upload.filename).slice(0, 120),
                    token: crypto.randomBytes(24).toString('base64url'), createdAt: Date.now() });
                return redirect(response, '/ledger/import');
            } catch (error) {
                pendingImport.delete(session.id);
                return send(response, error.code === 'BODY_TOO_LARGE' ? 413 : 400,
                    ledgerImportView({ session, error: error.message }));
            }
        }

        if (url.pathname === '/ledger/import/confirm' && request.method === 'POST') {
            if (storageDriver !== 'sqlite') return send(response, 409, errorView({ session, statusCode: 409,
                title: 'Импорт недоступен', message: 'Для импорта включите локальный журнал SQLite.' }));
            const form = await readForm(request);
            if (form.csrf !== session.csrfToken) return send(response, 403, errorView({ session,
                statusCode: 403, title: 'Запрос отклонен', message: 'Обновите страницу и повторите действие.' }));
            const pending = pendingImport.get(session.id);
            if (!pending || pending.token !== form.token || Date.now() - pending.createdAt > 10 * 60 * 1000) {
                pendingImport.delete(session.id);
                return send(response, 409, ledgerImportView({ session,
                    error: 'Предпросмотр устарел. Загрузите файл заново.' }));
            }
            if (pending.preview.errors.length || !pending.preview.importable.length) {
                return send(response, 409, ledgerImportView({ session, pending,
                    error: 'Исправьте ошибки или добавьте новые записи перед подтверждением.' }));
            }
            if (incomeWriteInProgress) return send(response, 409, ledgerImportView({ session, pending,
                error: 'Другая запись уже выполняется. Повторите после ее завершения.' }));
            pendingImport.delete(session.id);
            incomeWriteInProgress = true;
            try {
                await executeModuleAction(smallBusinessModule, 'import-income', {
                    parsed: pending.parsed, recordsRepository, convertToGel,
                    confirmedFingerprint: importFingerprint(pending.preview), now: now()
                }, { confirmed: true, idempotencyKey: importIdempotencyKey(pending.preview) });
                return redirect(response, '/ledger?notice=imported');
            } catch (error) {
                return send(response, 409, ledgerImportView({ session, error: error.message }));
            } finally {
                incomeWriteInProgress = false;
            }
        }

        const ledgerActionMatch = url.pathname.match(/^\/ledger\/(\d+)\/(edit|delete|preview|confirm)$/);
        if (ledgerActionMatch) {
            const id = Number(ledgerActionMatch[1]);
            const action = ledgerActionMatch[2];
            if (storageDriver !== 'sqlite' || !Number.isSafeInteger(id)) {
                return send(response, 409, errorView({ session, statusCode: 409,
                    title: 'Редактирование недоступно', message: 'Сначала выполните проверенный импорт в локальный журнал.' }));
            }
            if (request.method === 'GET' && action === 'edit') {
                const record = await recordsRepository.getRecord(id);
                if (!record || record.recordType !== 'Доход') return send(response, 404, errorView({ session, statusCode: 404,
                    title: 'Запись не найдена', message: 'Откройте журнал и выберите существующее поступление.' }));
                return send(response, 200, ledgerEditView({ session, record, now: now() }));
            }
            if (request.method === 'GET' && action === 'delete') {
                try {
                    const preview = await buildIncomeMaintenancePreview({ recordsRepository, id,
                        intent: 'delete', convertToGel, now: now() });
                    pendingMaintenance.set(session.id, { preview, rawInput: {},
                        token: crypto.randomBytes(24).toString('base64url'), createdAt: Date.now() });
                    return redirect(response, `/ledger/${id}/preview`);
                } catch (error) {
                    return send(response, 409, errorView({ session, statusCode: 409,
                        title: 'Удаление недоступно', message: error.message }));
                }
            }
            if (request.method === 'POST' && action === 'preview') {
                const form = await readForm(request);
                if (form.csrf !== session.csrfToken) return send(response, 403, errorView({ session, statusCode: 403,
                    title: 'Запрос отклонен', message: 'Обновите страницу и повторите действие.' }));
                const record = await recordsRepository.getRecord(id);
                if (!record) return send(response, 404, errorView({ session, statusCode: 404,
                    title: 'Запись не найдена', message: 'Обновите журнал.' }));
                const rawInput = { date: form.date, amount: form.amount, currency: form.currency,
                    description: form.description, paymentDate: form.paymentDate };
                try {
                    const preview = await buildIncomeMaintenancePreview({ recordsRepository, id,
                        intent: 'edit', input: rawInput, convertToGel, now: now() });
                    pendingMaintenance.set(session.id, { preview, rawInput,
                        token: crypto.randomBytes(24).toString('base64url'), createdAt: Date.now() });
                    return redirect(response, `/ledger/${id}/preview`);
                } catch (error) {
                    return send(response, 400, ledgerEditView({ session, record, input: rawInput,
                        error: error.message, now: now() }));
                }
            }
            if (request.method === 'GET' && action === 'preview') {
                const pending = pendingMaintenance.get(session.id);
                if (!pending || pending.preview.id !== id || Date.now() - pending.createdAt > 10 * 60 * 1000) {
                    return send(response, 409, errorView({ session, statusCode: 409,
                        title: 'Предпросмотр устарел', message: 'Откройте запись заново.' }));
                }
                return send(response, 200, ledgerPreviewView({ session, pending }));
            }
            if (request.method === 'POST' && action === 'confirm') {
                const form = await readForm(request);
                if (form.csrf !== session.csrfToken) return send(response, 403, errorView({ session, statusCode: 403,
                    title: 'Запрос отклонен', message: 'Обновите страницу и повторите действие.' }));
                const pending = pendingMaintenance.get(session.id);
                if (!pending || pending.preview.id !== id || pending.token !== form.token ||
                    Date.now() - pending.createdAt > 10 * 60 * 1000) {
                    return send(response, 409, errorView({ session, statusCode: 409,
                        title: 'Подтверждение устарело', message: 'Проверьте актуальные данные заново.' }));
                }
                if (incomeWriteInProgress) return send(response, 409, errorView({ session, statusCode: 409,
                    title: 'Запись выполняется', message: 'Дождитесь завершения другого изменения.' }));
                pendingMaintenance.delete(session.id);
                incomeWriteInProgress = true;
                const intent = pending.preview.after ? 'edit' : 'delete';
                try {
                    await executeModuleAction(smallBusinessModule, intent === 'edit' ? 'edit-income' : 'delete-income', {
                        recordsRepository, id, rawInput: pending.rawInput, convertToGel,
                        confirmedFingerprint: maintenanceFingerprint(pending.preview), now: now()
                    }, { confirmed: true, idempotencyKey: maintenanceIdempotencyKey(pending.preview) });
                    const date = pending.preview.before.date;
                    return redirect(response, `/ledger?period=${date.slice(0, 7)}&notice=${intent === 'edit' ? 'updated' : 'deleted'}`);
                } catch (error) {
                    return send(response, 409, errorView({ session, statusCode: 409,
                        title: 'Изменение не сохранено', message: error.message }));
                } finally {
                    incomeWriteInProgress = false;
                }
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

        if (request.method === 'POST' && url.pathname === '/declarations') {
            const form = await readForm(request);
            if (form.csrf !== session.csrfToken) return send(response, 403, errorView({ session, statusCode: 403, title: 'Запрос отклонен', message: 'Обновите страницу и повторите действие.' }));
            const year = Number(form.year);
            const month = Number(form.month);
            const kind = form.kind;
            if (!isValidReportPeriod(year, month, now()) || !['draft', 'submit'].includes(kind)) {
                return send(response, 400, errorView({ session, statusCode: 400, title: 'Некорректные параметры', message: 'Выберите доступный период и действие.' }));
            }
            const period = checkSubmissionPeriod(year, month, now());
            if (!period.canSubmit) return send(response, 409, errorView({ session, statusCode: 409, title: 'Период еще не открыт', message: period.message }));
            try {
                const operation = operations.start({ sessionId: session.id, year, month, kind });
                return redirect(response, `/operations/${operation.id}`);
            } catch (error) {
                return send(response, 409, errorView({ session, statusCode: 409, title: 'Действие не запущено', message: error.message }));
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

        const imageMatch = url.pathname.match(/^\/operations\/([a-f0-9-]+)\/image$/i);
        if (request.method === 'GET' && imageMatch) {
            const image = operations.getImage({ id: imageMatch[1], sessionId: session.id, kind: url.searchParams.get('kind') });
            if (!image) return send(response, 404, 'Изображение недоступно', 'text/plain; charset=utf-8');
            return send(response, 200, image, 'image/png', { 'Cache-Control': 'private, no-store' });
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

        const decisionMatch = url.pathname.match(/^\/operations\/([a-f0-9-]+)\/(confirm|cancel)$/i);
        if (request.method === 'POST' && decisionMatch) {
            const form = await readForm(request);
            if (form.csrf !== session.csrfToken) return send(response, 403, errorView({ session, statusCode: 403, title: 'Запрос отклонен', message: 'Обновите страницу и повторите действие.' }));
            const accepted = decisionMatch[2] === 'confirm'
                ? operations.confirm({ id: decisionMatch[1], sessionId: session.id })
                : operations.cancel({ id: decisionMatch[1], sessionId: session.id });
            if (!accepted) return send(response, 409, errorView({ session, statusCode: 409, title: 'Подтверждение недоступно', message: 'Действие уже продолжилось или время ожидания истекло.' }));
            return redirect(response, `/operations/${decisionMatch[1]}`);
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
            if (ownsRepository && typeof recordsRepository.close === 'function') recordsRepository.close();
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
