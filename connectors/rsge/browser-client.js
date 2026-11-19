const playwright = require('../../services/playwright');

function createRsGeBrowserClient(page) {
    if (!page) throw new Error('RS.GE browser client требует активную Playwright page');

    return Object.freeze({
        getPaymentHistory: (options) => playwright.getPaymentHistory(page, options),
        openExistingSmallBusinessDraft: (year, month) => (
            playwright.openExistingSmallBusinessDraft(page, year, month)
        ),
        createSmallBusinessDraft: (preview, options) => (
            playwright.createSmallBusinessDraft(page, preview, options)
        ),
        submitSmallBusinessDeclaration: (preview, options) => (
            playwright.submitSmallBusinessDeclaration(page, preview, options)
        )
    });
}

module.exports = { createRsGeBrowserClient };
