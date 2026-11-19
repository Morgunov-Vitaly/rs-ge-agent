/**
 * services/playwright.js
 * Браузерная автоматизация портала налоговой службы Грузии (rs.ge).
 * Авторизация, обработка SMS 2FA, навигация к декларациям малого бизнеса.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { config, assertConfig } = require('../config');
const {
    detectLoginState,
    readSmallBusinessDraftPage,
    readPayerCardTable
} = require('../connectors/rsge/page-readers');
const { writeSmallBusinessDraftPage } = require('../connectors/rsge/page-writers');

const SESSION_STORAGE_PATH = config.rsGe.sessionStoragePath;
const SCREENSHOTS_DIR = config.rsGe.screenshotsDir;
const MAIN_PAGE_URL = 'https://eservices.rs.ge/MainPage.aspx';
const DECLARATIONS_URL = 'https://decl.rs.ge/decls.aspx';
const ACCOUNTING_URL = 'https://eservices.rs.ge/Accounting.aspx?tab=tabComparisoAct';
const SMALL_BUSINESS_TAX_NAME = 'მცირე ბიზნესის საშემოსავლო გადასახადი';
const RS_MONTHS = {
    იან: 1,
    თებ: 2,
    მარ: 3,
    აპრ: 4,
    მაი: 5,
    ივნ: 6,
    ივლ: 7,
    აგვ: 8,
    სექ: 9,
    ოქტ: 10,
    ნოე: 11,
    დეკ: 12
};

if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Запуск браузера с поддержкой headless и системного chromium
 */
async function launchBrowser(headless = true) {
    const launchOptions = {
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    };

    if (config.rsGe.chromiumExecutablePath) {
        launchOptions.executablePath = config.rsGe.chromiumExecutablePath;
    } else {
        // New Playwright versions prefer a separate headless-shell binary.
        // Reuse the installed full Chromium build when the shell is absent.
        const browserCandidates = [
            chromium.executablePath(),
            '/usr/bin/chromium',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable'
        ];
        launchOptions.executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
        if (!launchOptions.executablePath) delete launchOptions.executablePath;
    }

    return await chromium.launch(launchOptions);
}

/**
 * Создание контекста с возможностью переиспользования сохраненной сессии
 */
async function createBrowserContext(browser) {
    let contextOptions = {
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    };

    if (fs.existsSync(SESSION_STORAGE_PATH)) {
        try {
            contextOptions.storageState = SESSION_STORAGE_PATH;
            logger.info('Загружена сохраненная сессия из session_state.json');
        } catch (e) {
            logger.warn('Не удалось загрузить session_state.json:', e.message);
        }
    }

    return await browser.newContext(contextOptions);
}

async function saveRuntimeScreenshot(fileName, screenshotBuffer) {
    try {
        await fs.promises.writeFile(path.join(SCREENSHOTS_DIR, fileName), screenshotBuffer);
        return true;
    } catch (error) {
        // Скриншот — диагностический артефакт, а не результат операции.
        // Особенно важно не сообщать failure после уже выполненного DRAFT_WRITE.
        logger.warn(`Не удалось сохранить временный скриншот ${fileName}: ${error.code || error.name}`);
        return false;
    }
}

/**
 * Авторизация на eservices.rs.ge с точными селекторами (#username, #password, #btnLogin, #smsText)
 * @param {Function} onSmsRequired - callback: async (screenshotBuffer) => string (возвращает sms код)
 * @returns {Promise<{page, browser, context, isLoggedIn: boolean}>}
 */
async function loginToRsGe(onSmsRequired) {
    let browser;
    let context;
    let page;

    try {
        assertConfig(config, ['rsge']);

        browser = await launchBrowser(true);
        context = await createBrowserContext(browser);
        page = await context.newPage();

        logger.info('Открываем https://eservices.rs.ge/Login.aspx...');
        await page.goto('https://eservices.rs.ge/Login.aspx?redirect_url=http://eservices.rs.ge/Login.aspx', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // Проверяем, авторизованы ли мы уже
        const currentUrl = page.url();
        if (!currentUrl.toLowerCase().includes('login.aspx')) {
            logger.info('Уже авторизованы по сохраненной сессии.');
            return { browser, context, page, isLoggedIn: true };
        }

        logger.info('Вводим логин и пароль...');
        await page.locator('#username').fill(config.rsGe.username);
        await page.locator('#password').fill(config.rsGe.password);

        logger.info('Отправляем форму авторизации...');
        await page.locator('#btnLogin').click();

        // Ожидаем появления поля ввода SMS
        logger.info('Ожидаем появления #smsText...');
        await page.waitForSelector('#smsText', { state: 'visible', timeout: 15000 });
        logger.info('Поле ввода SMS (#smsText) появилось на экране.');

        const screenshotPath = path.join(SCREENSHOTS_DIR, 'login_step.png');
        const loginScreenshot = await page.screenshot({ fullPage: true });
        await fs.promises.writeFile(screenshotPath, loginScreenshot);

        if (!onSmsRequired) {
            throw new Error('Не задан обработчик получения SMS-кода');
        }

        const smsCode = await onSmsRequired(loginScreenshot);
        if (!smsCode) {
            throw new Error('SMS-код не был получен');
        }

        logger.info('SMS-код получен из Telegram, отправляем его на RS.GE...');
        await page.locator('#smsText').fill(String(smsCode).trim());
        await page.locator('#btnSmsLogin').click();

        logger.info('Ожидаем результат проверки SMS-кода...');
        await Promise.any([
            page.waitForURL(
                (url) => !url.toString().toLowerCase().includes('login.aspx'),
                { timeout: 20000 }
            ),
            page.locator('#smsText').waitFor({ state: 'hidden', timeout: 20000 })
        ]).catch(() => undefined);

        // Форма может скрываться на время postback, поэтому даем странице
        // закончить отрисовку ошибки или личного кабинета.
        await page.waitForTimeout(1200);
        const loginState = await detectLoginState(page);
        if (loginState !== 'authenticated') {
            const rejectedPath = path.join(SCREENSHOTS_DIR, 'sms_rejected.png');
            await page.screenshot({ path: rejectedPath, fullPage: true });
            throw new Error('RS.GE не принял SMS-код или срок его действия истек. Запустите /fill заново.');
        }

        const afterSmsPath = path.join(SCREENSHOTS_DIR, 'after_sms.png');
        await page.screenshot({ path: afterSmsPath, fullPage: true });

        await context.storageState({ path: SESSION_STORAGE_PATH });
        logger.info('Авторизация подтверждена, сессия сохранена в session_state.json');

        return { browser, context, page, isLoggedIn: true };
    } catch (err) {
        logger.error('Ошибка на этапе ожидания/ввода SMS:', err);
        if (page && !page.isClosed()) {
            const errPath = path.join(SCREENSHOTS_DIR, 'error_step.png');
            await page.screenshot({ path: errPath, fullPage: true }).catch(() => undefined);
        }
        if (browser) {
            await browser.close().catch(() => undefined);
        }
        throw err;
    }
}

/**
 * Открывает существующий сохраненный черновик декларации малого бизнеса.
 * Функция ничего не изменяет и не отправляет на RS.GE.
 *
 * @param {import('playwright').Page} page
 * @param {number} year
 * @param {number} month 1-12
 * @returns {Promise<{
 *   exists: boolean,
 *   status?: string,
 *   fields?: Record<string, number>,
 *   screenshotBuffer?: Buffer
 * }>}
 */
async function openSmallBusinessDeclarations(page, expectedPeriod) {
    logger.info(`Открываем раздел деклараций за ${expectedPeriod}...`);
    await page.goto(MAIN_PAGE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    if (page.url().toLowerCase().includes('login.aspx')) {
        throw new Error('Сессия RS.GE истекла. Запустите /fill и войдите заново.');
    }

    // Авторизация на decl.rs.ge устанавливается только при переходе через
    // карточку модуля на главной странице, прямой goto не переносит сессию.
    const declarationsModule = page
        .locator('.divModuleName')
        .filter({ hasText: /^დეკლარაციები$/ })
        .first();
    await declarationsModule.waitFor({ state: 'visible', timeout: 30000 });
    await declarationsModule.click();
    await page.waitForURL(DECLARATIONS_URL, { timeout: 30000 });

    await page.getByRole('tab', { name: 'ყოველთვიური' }).click({ timeout: 30000 });

    // Список деклараций загружается отдельным AJAX-запросом уже после click.
    // Проверка grid сразу после клика иногда видит только скрытую template-row
    // и ошибочно сообщает, что декларации нет. Ждем завершения именно grid data.
    const gridResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.hostname === 'decl.rs.ge' &&
            url.pathname.endsWith('/sys_service.asmx/get_grid_s_data') &&
            response.request().method() === 'POST' &&
            response.status() === 200;
    }, { timeout: 30000 });
    await page.getByRole('cell', { name: SMALL_BUSINESS_TAX_NAME }).click();
    try {
        await gridResponse;
        await page.locator('#control_0_g3g').waitFor({ state: 'attached', timeout: 10000 });
        await page.waitForFunction(() => {
            const grid = document.querySelector('#control_0_g3g');
            return grid && grid.classList.contains('end_out');
        }, undefined, { timeout: 10000 });
        // jQuery grid inserts rows immediately after resolving its data request.
        await page.waitForTimeout(100);
    } catch (cause) {
        const error = new Error('RS.GE page contract changed: declaration grid did not finish loading');
        error.code = 'RSGE_PAGE_CONTRACT_CHANGED';
        error.cause = cause;
        throw error;
    }
}

async function openExistingSmallBusinessDraft(page, year, month) {
    const expectedPeriod = `${String(month).padStart(2, '0')}.${year}`;
    await openSmallBusinessDeclarations(page, expectedPeriod);

    const result = await readSmallBusinessDraftPage(page, expectedPeriod);
    if (!result.exists) {
        logger.info(`Сохраненный черновик за ${expectedPeriod} не найден.`);
        return result;
    }
    await saveRuntimeScreenshot('declaration_draft.png', result.screenshotBuffer);

    logger.info(`Декларация за ${expectedPeriod} открыта в режиме просмотра (статус: ${result.status}).`);
    return result;
}

/**
 * Создает и сохраняет черновик декларации. Финальная отправка декларации
 * не входит в контракт этой функции и технически здесь не реализована.
 */
async function createSmallBusinessDraft(page, preview) {
    await openSmallBusinessDeclarations(page, preview.period);
    const result = await writeSmallBusinessDraftPage(page, preview);
    await saveRuntimeScreenshot('declaration_draft_created.png', result.screenshotBuffer);
    logger.info(`Черновик за ${preview.period} сохранен и повторно проверен.`);
    return result;
}

function formatIsoDate(year, month, day) {
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() + 1 !== month ||
        parsed.getUTCDate() !== day
    ) {
        return '';
    }

    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseRsGeDate(value) {
    const match = String(value || '').trim().match(/^(\d{1,2})-([^\s-]+)-(\d{4})$/);
    if (!match) return '';

    const month = RS_MONTHS[match[2]];
    if (!month) return '';
    return formatIsoDate(Number(match[3]), month, Number(match[1]));
}

function parsePaymentOrderDate(description) {
    const match = String(description || '').match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[^\d]|$)/);
    if (!match) return '';
    return formatIsoDate(Number(match[3]), Number(match[2]), Number(match[1]));
}

async function setRsGeDate(page, selector, date) {
    await page.locator(selector).waitFor({ state: 'attached', timeout: 10000 });
    await page.evaluate(({ dateSelector, day, month, year }) => {
        const widget = document.querySelector(dateSelector);
        const dayInput = widget.querySelector('.rsDateDay');
        const monthSelect = widget.querySelector('.rsDateMonth');
        const yearSelect = widget.querySelector('.rsDateYear');

        dayInput.value = String(day);
        monthSelect.value = String(month);
        yearSelect.value = String(year);
        dayInput.dispatchEvent(new Event('change', { bubbles: true }));
        monthSelect.dispatchEvent(new Event('change', { bubbles: true }));
        yearSelect.dispatchEvent(new Event('change', { bubbles: true }));
        widget.querySelector('.rsDateRefresh').click();
    }, {
        dateSelector: selector,
        day: date.getUTCDate(),
        month: date.getUTCMonth(),
        year: date.getUTCFullYear()
    });
}

function parsePayerCardRows(rows) {
    const operations = rows
        .filter((row) => row.length === 20 && row[0] && row[2])
        .map((row) => ({
            postedDate: parseRsGeDate(row[0]),
            taxType: row[1],
            description: row[2],
            effectiveDate: parseRsGeDate(row[3]),
            charged: Number(row[4]) || 0,
            paid: Number(row[8]) || 0,
            debt: Number(row[13]) || 0,
            overpayment: Number(row[18]) || 0
        }));

    const payments = operations
        .filter((operation) => operation.paid > 0)
        .map((operation) => ({
            paymentDate: parsePaymentOrderDate(operation.description) || operation.effectiveDate || operation.postedDate,
            postedDate: operation.postedDate,
            effectiveDate: operation.effectiveDate,
            amount: operation.paid,
            description: operation.description,
            reference: operation.description.match(/;\s*(\d+)\s*$/)?.[1] || ''
        }));

    const charges = operations
        .filter((operation) => operation.charged > 0)
        .map((operation) => ({
            postedDate: operation.postedDate,
            effectiveDate: operation.effectiveDate,
            amount: operation.charged,
            taxType: operation.taxType,
            description: operation.description
        }));

    const endingBalance = [...operations]
        .reverse()
        .find((operation) => operation.description.includes('ნაშთი პერიოდის ბოლოს'));

    return {
        payments,
        charges,
        balance: endingBalance
            ? { debt: endingBalance.debt, overpayment: endingBalance.overpayment }
            : null
    };
}

/**
 * Читает личную карточку налогоплательщика за указанные календарные годы.
 * Функция только читает данные и ничего не изменяет на RS.GE.
 *
 * @param {import('playwright').Page} page
 * @param {{years?: number[]}} options
 */
async function getPaymentHistory(page, options = {}) {
    const currentYear = new Date().getFullYear();
    const years = [...new Set(options.years || [currentYear])]
        .map(Number)
        .filter((year) => Number.isInteger(year) && year >= 2016 && year <= currentYear)
        .sort((left, right) => left - right);

    if (years.length === 0) years.push(currentYear);

    logger.info(`Открываем личную карточку RS.GE за годы: ${years.join(', ')}...`);
    await page.goto(ACCOUNTING_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    if (page.url().toLowerCase().includes('login.aspx')) {
        throw new Error('Сессия RS.GE истекла. Запустите команду повторно и войдите заново.');
    }

    // Вкладки старого ASP.NET-интерфейса получают обработчики после
    // DOMContentLoaded. Ранний click визуально проходит, но панель не меняется.
    await page.waitForLoadState('load', { timeout: 30000 });
    await page.waitForFunction(
        () => typeof window.updateGrdPayerCard === 'function',
        undefined,
        { timeout: 30000 }
    );
    await page.locator('#tabPayerCard').click({ timeout: 30000 });
    await page.waitForTimeout(500);
    await page.locator('#drpPayerCardType select').waitFor({ state: 'attached', timeout: 30000 });
    await page.locator('#drpPayerCardType select').selectOption('2', { force: true });
    await page.locator('#drpPayerCardCategory select').selectOption('0', { force: true });

    const allPayments = [];
    const allCharges = [];
    let latestBalance = null;

    for (const year of years) {
        const endDate = year === currentYear
            ? new Date()
            : new Date(Date.UTC(year, 11, 31));

        await setRsGeDate(page, '#dpPayerCardStart', new Date(Date.UTC(year, 0, 1)));
        await setRsGeDate(page, '#dpPayerCardEnd', endDate);

        await Promise.all([
            page.waitForResponse(
                (response) => (
                    response.url().endsWith('/WebServices/hsAccounting.ashx/GetPayerCards') &&
                    response.request().method() === 'POST' &&
                    response.status() === 200
                ),
                { timeout: 30000 }
            ),
            page.locator('[onclick="updateGrdPayerCard()"], [onclick="updateGrdPayerCard();"]').click({ force: true })
        ]);
        await page.waitForTimeout(500);

        const alert = page.locator('#rsAlert');
        if (await alert.isVisible().catch(() => false)) {
            const alertText = (await alert.innerText()).replace(/\s+/g, ' ').trim();
            throw new Error(`RS.GE не смог загрузить личную карточку за ${year} год: ${alertText}`);
        }

        const pageSize = page.locator('#rsGrid_grdPayerCard select.rsGridMaxRows');
        if (await pageSize.count()) {
            const gridText = await page.locator('#rsGrid_grdPayerCard').innerText();
            const totalRows = Number(gridText.match(/(\d+)\s*ჩანაწერი/)?.[1] || 0);
            await pageSize.selectOption('300');
            if (totalRows > 10) {
                await page.waitForFunction(
                    ({ selector, expectedRows }) => (
                        Array.from(document.querySelectorAll(`${selector} tr`))
                            .filter((row) => row.querySelectorAll('td').length === 20)
                            .length >= expectedRows
                    ),
                    { selector: '#rsGrid_grdPayerCard', expectedRows: totalRows },
                    { timeout: 10000 }
                );
            }
        }

        const rows = await readPayerCardTable(page);
        const parsed = parsePayerCardRows(rows);
        allPayments.push(...parsed.payments);
        allCharges.push(...parsed.charges);
        if (year === years.at(-1)) latestBalance = parsed.balance;
    }

    logger.info(`RS.GE: найдено платежей ${allPayments.length}, начислений ${allCharges.length}.`);
    return {
        years,
        payments: allPayments,
        charges: allCharges,
        balance: latestBalance
    };
}

module.exports = {
    loginToRsGe,
    openExistingSmallBusinessDraft,
    createSmallBusinessDraft,
    getPaymentHistory,
    parseRsGeDate,
    parsePaymentOrderDate,
    parsePayerCardRows,
    launchBrowser,
    createBrowserContext
};
