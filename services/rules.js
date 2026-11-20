/**
 * Compatibility facade. Новая бизнес-логика находится в domain/ и не
 * зависит от Telegram, Google Sheets или Playwright.
 */
const {
    checkSubmissionPeriod,
    calculateSmallBusinessTax
} = require('../domain/small-business');

/**
 * Получить платежные реквизиты для оплаты налога в Казначейство Грузии
 * @param {string} [taxPayerId=''] - ИНН / Личный номер ИП
 * @param {number} [amountGel=0] - сумма налога
 * @returns {{
 *   treasuryCode: string,
 *   paymentUrl: string,
 *   instructions: string
 * }}
 */
function getPaymentDetails(taxPayerId = '', amountGel = 0) {
    return {
        treasuryCode: '101001000',
        paymentUrl: 'https://www.rs.ge/ePaymentTabOne-EN',
        instructions: `Реквизиты для оплаты налога в бюджет Грузии:\n` +
            `• Получатель: Государственное казначейство (Treasury Service)\n` +
            `• Единый казначейский код: 101001000\n` +
            (taxPayerId ? `• ИНН налогоплательщика: ${taxPayerId}\n` : '• При оплате укажите ваш ИНН налогоплательщика\n') +
            (amountGel ? `• Расчетный налог по журналу: ${amountGel.toFixed(2)} GEL\n` : '') +
            `• Перед платежом проверьте начисление и баланс в личной карточке RS.GE\n` +
            `• Быстрая онлайн-оплата картой: https://www.rs.ge/ePaymentTabOne-EN\n` +
            `• Срок оплаты: до 15 числа включительно`
    };
}

module.exports = {
    checkSubmissionPeriod,
    calculateSmallBusinessTax,
    getPaymentDetails
};
