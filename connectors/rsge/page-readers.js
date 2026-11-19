const DECLARATION_FIELD_NUMBERS = Object.freeze([15, 16, 17, 18, 19, 20, 21, 26]);

async function isVisible(page, selector) {
    return page.locator(selector).isVisible().catch(() => false);
}

async function detectLoginState(page) {
    if (await isVisible(page, '#smsText')) return 'sms';
    if (await isVisible(page, '#username') || await isVisible(page, '#password')) {
        return 'credentials';
    }
    return 'authenticated';
}

async function waitForContract(locator, message, timeout) {
    try {
        await locator.waitFor({ state: 'attached', timeout });
    } catch (error) {
        const contractError = new Error(`RS.GE page contract changed: ${message}`);
        contractError.code = 'RSGE_PAGE_CONTRACT_CHANGED';
        contractError.cause = error;
        throw contractError;
    }
}

async function readSmallBusinessDraftPage(page, expectedPeriod, options = {}) {
    const timeout = options.timeout || 10000;
    const periodInput = page.locator('#control_0_m input.d_value');
    await waitForContract(periodInput, 'declaration period field was not found', timeout);

    const selectedPeriod = await periodInput.inputValue();
    if (selectedPeriod !== expectedPeriod) {
        const error = new Error(
            `RS.GE opened period ${selectedPeriod || 'unknown'}, expected ${expectedPeriod}. ` +
            'Automatic period switching is disabled for safety.'
        );
        error.code = 'RSGE_UNEXPECTED_PERIOD';
        throw error;
    }

    const grid = page.locator('#control_0_g3g');
    await waitForContract(grid, 'declaration grid was not found', timeout);

    // RS.GE keeps a hidden template row containing {$T.*} placeholders.
    // It must never be interpreted as a real declaration.
    const viewButtons = grid.locator('img[src$="view.png"]:visible');
    if (await viewButtons.count() === 0) {
        return { exists: false };
    }

    const draftRow = viewButtons.first().locator('xpath=ancestor::tr[count(td) >= 5][1]');
    const rowCells = await draftRow.locator('td').allInnerTexts();
    const normalizedCells = rowCells.map((value) => value.trim()).filter(Boolean);
    const rawStatus = normalizedCells.find((value) => (
        /შენახულ|გაგზავნილ|გადაგზავნილ|sent/i.test(value)
    )) || '';
    const status = rawStatus.includes('შენახული')
        ? 'Сохранен'
        : (/გაგზავნილ|გადაგზავნილ|sent/i.test(rawStatus)
            ? 'Sent'
            : (rawStatus || 'Неизвестен'));

    await viewButtons.first().click();
    const draftWindow = page.locator('.window_panel').filter({
        has: page.locator('input[id$="_20"].decl_input_tb')
    }).last();
    await waitForContract(draftWindow, 'declaration details window was not found', timeout);
    try {
        await draftWindow.waitFor({ state: 'visible', timeout });
    } catch (error) {
        const contractError = new Error('RS.GE page contract changed: declaration details window did not open');
        contractError.code = 'RSGE_PAGE_CONTRACT_CHANGED';
        contractError.cause = error;
        throw contractError;
    }

    const fields = {};
    for (const fieldNumber of DECLARATION_FIELD_NUMBERS) {
        const field = draftWindow.locator(`input[id$="_${fieldNumber}"].decl_input_tb`).first();
        await waitForContract(field, `declaration field ${fieldNumber} was not found`, timeout);
        const value = Number((await field.inputValue()).replace(',', '.'));
        fields[fieldNumber] = Number.isFinite(value) ? value : 0;
    }

    return {
        exists: true,
        status,
        fields,
        screenshotBuffer: await draftWindow.screenshot()
    };
}

async function readPayerCardTable(page, options = {}) {
    const timeout = options.timeout || 10000;
    const grid = page.locator('#rsGrid_grdPayerCard');
    await waitForContract(grid, 'payer-card grid was not found', timeout);

    return grid.locator('tr').evaluateAll((tableRows) => (
        tableRows.map((row) => (
            Array.from(row.querySelectorAll('td')).map((cell) => cell.innerText.trim())
        ))
    ));
}

module.exports = {
    DECLARATION_FIELD_NUMBERS,
    detectLoginState,
    readSmallBusinessDraftPage,
    readPayerCardTable
};
