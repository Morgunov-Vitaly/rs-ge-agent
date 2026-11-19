const { readSmallBusinessDraftPage } = require('./page-readers');
const { fieldsMatch, readEditorFields } = require('./page-writers');

function contractError(message, code = 'RSGE_PAGE_CONTRACT_CHANGED', cause) {
    const error = new Error(`RS.GE page contract changed: ${message}`);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
}

async function firstVisible(candidates) {
    for (const candidate of candidates) {
        if (await candidate.first().isVisible().catch(() => false)) return candidate.first();
    }
    return null;
}

async function waitForSubmitOutcome(page, timeout) {
    await page.waitForFunction(() => {
        const visible = (element) => {
            if (!element) return false;
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const sent = Array.from(document.querySelectorAll('#control_0_g3g td')).some((cell) => (
            visible(cell) && /გაგზავნილ|გადაგზავნილ|sent/i.test(cell.innerText)
        ));
        const confirmation = Array.from(document.querySelectorAll(
            '.window_panel button, .window_panel input[type="button"], [role="dialog"] button'
        )).some((control) => (
            visible(control) && /^(?:დიახ|yes|confirm|დადასტურება)$/i.test(
                String(control.innerText || control.value || '').trim()
            )
        ));
        return sent || confirmation;
    }, undefined, { timeout });
}

async function submitSmallBusinessDeclarationPage(page, preview, options = {}) {
    const timeout = options.timeout || 10000;
    const periodInput = page.locator('#control_0_m input.d_value');
    await periodInput.waitFor({ state: 'attached', timeout }).catch(() => {
        throw contractError('declaration period field was not found before submit');
    });
    const selectedPeriod = await periodInput.inputValue();
    if (selectedPeriod !== preview.period) {
        const error = new Error(
            `RS.GE opened period ${selectedPeriod || 'unknown'}, expected ${preview.period}. ` +
            'Submission is blocked.'
        );
        error.code = 'RSGE_UNEXPECTED_PERIOD';
        throw error;
    }

    const draftWindow = page.locator('.window_panel:visible').filter({
        has: page.locator('input[id$="_20"].decl_input_tb')
    }).last();
    await draftWindow.waitFor({ state: 'visible', timeout }).catch(() => {
        throw contractError('saved declaration window was not open before submit');
    });
    const actualFields = await readEditorFields(draftWindow);
    if (!fieldsMatch(actualFields, preview.fields)) {
        const error = new Error(
            'RS.GE declaration values changed after confirmation. Submission is blocked.'
        );
        error.code = 'RSGE_SUBMISSION_VALUES_MISMATCH';
        throw error;
    }

    const submitButton = await firstVisible([
        draftWindow.getByRole('button', { name: /^(?:გაგზავნა|submit(?: declaration)?|send)$/i }),
        draftWindow.getByRole('link', { name: /^(?:გაგზავნა|submit(?: declaration)?|send)$/i }),
        draftWindow.getByRole('cell', { name: /^(?:გაგზავნა|submit(?: declaration)?|send)$/i }),
        draftWindow.locator('[data-action="submit-declaration"]'),
        draftWindow.locator('input[type="button"][value="გაგზავნა"]')
    ]);
    if (!submitButton) throw contractError('unambiguous final-submit control was not found');

    const preSubmitScreenshotBuffer = await draftWindow.screenshot();
    let submissionInitiated = false;
    let dialogFailure = null;
    const dialogHandler = async (dialog) => {
        const message = dialog.message();
        if (dialog.type() === 'confirm' && /გაგზავნ|submit|send|declaration/i.test(message)) {
            await dialog.accept();
            return;
        }
        dialogFailure = contractError('unexpected browser confirmation dialog during submit');
        await dialog.dismiss();
    };
    page.on('dialog', dialogHandler);

    try {
        submissionInitiated = true;
        await submitButton.click();
        await waitForSubmitOutcome(page, timeout);
        if (dialogFailure) throw dialogFailure;

        const confirmationButton = await firstVisible([
            page.locator('.window_panel:visible').getByRole('button', { name: /^(?:დიახ|yes|confirm|დადასტურება)$/i }),
            page.locator('[role="dialog"]:visible').getByRole('button', { name: /^(?:დიახ|yes|confirm)$/i }),
            page.locator('.window_panel:visible [data-action="confirm-submit"]')
        ]);
        if (confirmationButton) await confirmationButton.click();

        await page.waitForFunction(() => (
            Array.from(document.querySelectorAll('#control_0_g3g td')).some((cell) => (
                cell.getClientRects().length > 0 &&
                /გაგზავნილ|გადაგზავნილ|sent/i.test(cell.innerText)
            ))
        ), undefined, { timeout });

        const declaration = await readSmallBusinessDraftPage(page, preview.period, { timeout });
        if (!/sent|გაგზავნილ|გადაგზავნილ/i.test(declaration.status || '')) {
            throw contractError('portal did not expose a Sent declaration after submit');
        }
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        return { ...declaration, preSubmitScreenshotBuffer, pdfBuffer };
    } catch (cause) {
        if (submissionInitiated && cause.code !== 'RSGE_SUBMISSION_VALUES_MISMATCH') {
            throw contractError(
                'submission was initiated but its final status could not be proven; do not retry automatically',
                'RSGE_SUBMISSION_OUTCOME_UNKNOWN',
                cause
            );
        }
        throw cause;
    } finally {
        page.off('dialog', dialogHandler);
    }
}

module.exports = { submitSmallBusinessDeclarationPage };
