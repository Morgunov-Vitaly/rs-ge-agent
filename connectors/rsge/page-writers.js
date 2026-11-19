const { readSmallBusinessDraftPage } = require('./page-readers');

const VERIFIED_FIELDS = Object.freeze([15, 16, 17, 18, 19, 20, 21, 26]);

function contractError(message, code = 'RSGE_PAGE_CONTRACT_CHANGED') {
    const error = new Error(`RS.GE page contract changed: ${message}`);
    error.code = code;
    return error;
}

async function firstVisible(candidates) {
    for (const candidate of candidates) {
        if (await candidate.first().isVisible().catch(() => false)) return candidate.first();
    }
    return null;
}

async function requireVisible(candidates, message) {
    const locator = await firstVisible(candidates);
    if (!locator) throw contractError(message);
    return locator;
}

function parsePortalNumber(value) {
    const normalized = String(value || '').trim().replace(/\s/g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : NaN;
}

function formatPortalNumber(value) {
    return Number(value).toFixed(2);
}

async function readEditorFields(draftWindow) {
    const fields = {};
    for (const fieldNumber of VERIFIED_FIELDS) {
        const field = draftWindow.locator(`input[id$="_${fieldNumber}"].decl_input_tb`).first();
        if (!await field.isVisible().catch(() => false)) {
            throw contractError(`declaration field ${fieldNumber} was not found in editor`);
        }
        fields[fieldNumber] = parsePortalNumber(await field.inputValue());
    }
    return fields;
}

function fieldsMatch(actual, expected, tolerance = 0.02) {
    return VERIFIED_FIELDS.every((field) => (
        Number.isFinite(actual[field]) &&
        Math.abs(actual[field] - Number(expected[field])) <= tolerance
    ));
}

async function waitForExpectedFields(page, draftWindow, expected, timeout) {
    const deadline = Date.now() + timeout;
    let actual = await readEditorFields(draftWindow);
    while (!fieldsMatch(actual, expected) && Date.now() < deadline) {
        await page.waitForTimeout(100);
        actual = await readEditorFields(draftWindow);
    }
    if (!fieldsMatch(actual, expected)) {
        const error = new Error(
            'RS.GE рассчитал значения, отличающиеся от подтвержденного preview. Черновик не сохранен.'
        );
        error.code = 'RSGE_DRAFT_VALUES_MISMATCH';
        error.actualFields = actual;
        throw error;
    }
    return actual;
}

/**
 * Заполняет и сохраняет только черновик. Селекторы финальной отправки здесь
 * намеренно отсутствуют: этот адаптер не умеет подавать декларацию.
 */
async function writeSmallBusinessDraftPage(page, preview, options = {}) {
    const timeout = options.timeout || 10000;
    const periodInput = page.locator('#control_0_m input.d_value');
    await periodInput.waitFor({ state: 'attached', timeout }).catch(() => {
        throw contractError('declaration period field was not found');
    });
    const selectedPeriod = await periodInput.inputValue();
    if (selectedPeriod !== preview.period) {
        const error = new Error(
            `RS.GE opened period ${selectedPeriod || 'unknown'}, expected ${preview.period}. ` +
            'Automatic period switching is disabled for safety.'
        );
        error.code = 'RSGE_UNEXPECTED_PERIOD';
        throw error;
    }

    const grid = page.locator('#control_0_g3g');
    await grid.waitFor({ state: 'attached', timeout }).catch(() => {
        throw contractError('declaration grid was not found');
    });
    if (await grid.locator('img[src$="view.png"]:visible').count()) {
        const error = new Error(`На RS.GE уже существует декларация за ${preview.period}.`);
        error.code = 'DECLARATION_DRAFT_CONFLICT';
        throw error;
    }

    const createButton = await requireVisible([
        page.getByRole('button', { name: /ახალი დეკლარაცია|new (?:return|declaration)/i }),
        page.getByRole('link', { name: /ახალი დეკლარაცია|new (?:return|declaration)/i }),
        page.locator('[data-action="new-declaration"]'),
        page.locator('input[type="button"][value*="ახალი დეკლარაცია"]')
    ], 'safe new-declaration control was not found');
    await createButton.click();

    const draftWindow = page.locator('.window_panel').filter({
        has: page.locator('input[id$="_20"].decl_input_tb')
    }).last();
    await draftWindow.waitFor({ state: 'visible', timeout }).catch(() => {
        throw contractError('declaration editor did not open');
    });

    const visibleCheckboxes = draftWindow.locator('input[type="checkbox"]:visible');
    const autofill = await firstVisible([
        draftWindow.getByLabel(/ავტომატური შევსება|automatic (?:fill|completion)/i),
        draftWindow.locator('[data-action="autofill"]')
    ]);
    let autofillControl = autofill;
    if (!autofillControl && await visibleCheckboxes.count() === 1) {
        autofillControl = visibleCheckboxes.first();
    }
    if (!autofillControl) {
        throw contractError('unambiguous automatic-fill checkbox was not found');
    }
    if (!await autofillControl.isChecked()) await autofillControl.check();

    for (const fieldNumber of [18, 19, 20, 21]) {
        const field = draftWindow.locator(`input[id$="_${fieldNumber}"].decl_input_tb`).first();
        if (!await field.isVisible().catch(() => false)) {
            throw contractError(`editable declaration field ${fieldNumber} was not found`);
        }
        await field.fill(formatPortalNumber(preview.fields[fieldNumber]));
        await field.press('Tab');
    }

    await waitForExpectedFields(page, draftWindow, preview.fields, timeout);
    const editorScreenshotBuffer = await draftWindow.screenshot();

    const saveButton = await requireVisible([
        draftWindow.getByRole('button', { name: /^(?:შენახვა|save(?: draft)?)$/i }),
        draftWindow.getByRole('link', { name: /^(?:შენახვა|save(?: draft)?)$/i }),
        draftWindow.locator('[data-action="save-draft"]'),
        draftWindow.locator('input[type="button"][value="შენახვა"]')
    ], 'safe save-draft control was not found');
    await saveButton.click();

    await grid.locator('img[src$="view.png"]:visible').first()
        .waitFor({ state: 'visible', timeout })
        .catch(() => {
            throw contractError('saved declaration did not appear in the grid', 'RSGE_DRAFT_NOT_SAVED');
        });

    const savedDraft = await readSmallBusinessDraftPage(page, preview.period, { timeout });
    return { ...savedDraft, editorScreenshotBuffer };
}

module.exports = {
    VERIFIED_FIELDS,
    parsePortalNumber,
    writeSmallBusinessDraftPage
};
