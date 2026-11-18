/**
 * services/nbg.js
 * Модуль интеграции с открытым API Национального банка Грузии (NBG).
 * Получает официальные курсы валют на дату поступления дохода.
 */

const NBG_API_BASE = 'https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/';

/**
 * Приводит дату к формату YYYY-MM-DD
 * @param {string|Date} inputDate
 * @returns {string}
 */
function formatDate(inputDate) {
    if (!inputDate) {
        return new Date().toISOString().slice(0, 10);
    }
    if (inputDate instanceof Date) {
        return inputDate.toISOString().slice(0, 10);
    }
    // Если передано ДД.ММ или ДД.ММ.ГГГГ
    if (typeof inputDate === 'string' && inputDate.includes('.')) {
        const parts = inputDate.split('.');
        const day = parts[0].padStart(2, '0');
        const month = parts[1].padStart(2, '0');
        const year = parts[2] || new Date().getFullYear();
        return `${year}-${month}-${day}`;
    }
    return inputDate;
}

/**
 * Получить курс валюты к GEL на указанную дату
 * @param {string} currencyCode - USD, EUR, RUB и т.д.
 * @param {string|Date} date - дата поступления платежа
 * @returns {Promise<{rate: number, quantity: number, ratePerUnit: number, date: string}>}
 */
async function getExchangeRate(currencyCode, date) {
    const code = currencyCode.toUpperCase();
    if (code === 'GEL') {
        return {
            rate: 1,
            quantity: 1,
            ratePerUnit: 1,
            date: formatDate(date)
        };
    }

    const formattedDate = formatDate(date);
    const url = `${NBG_API_BASE}?currencies=${code}&date=${formattedDate}`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Ошибка запроса к NBG API: HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0 || !data[0].currencies) {
        throw new Error(`NBG API не вернул курсы на дату ${formattedDate}`);
    }

    const target = data[0].currencies.find(c => c.code === code);
    if (!target) {
        throw new Error(`Курс для валюты ${code} на дату ${formattedDate} не найден в ответе NBG`);
    }

    const rate = Number(target.rate);
    const quantity = Number(target.quantity) || 1;
    const ratePerUnit = rate / quantity;

    return {
        currency: code,
        rate,
        quantity,
        ratePerUnit,
        date: formattedDate
    };
}

/**
 * Конвертировать сумму в GEL по курсу NBG
 * @param {number} amount
 * @param {string} currencyCode
 * @param {string|Date} date
 * @returns {Promise<{amountOriginal: number, currency: string, rate: number, amountGel: number, date: string}>}
 */
async function convertToGel(amount, currencyCode, date) {
    const rateInfo = await getExchangeRate(currencyCode, date);
    const amountGel = Number((amount * rateInfo.ratePerUnit).toFixed(2));

    return {
        amountOriginal: amount,
        currency: rateInfo.currency,
        rate: rateInfo.ratePerUnit,
        amountGel,
        date: rateInfo.date
    };
}

module.exports = {
    getExchangeRate,
    convertToGel,
    formatDate
};
