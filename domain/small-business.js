const STANDARD_ANNUAL_LIMIT = 500000;
const TOURISM_ANNUAL_LIMIT = 700000;

function checkSubmissionPeriod(targetYear, targetMonth, currentDate = new Date()) {
    const curYear = currentDate.getFullYear();
    const curMonth = currentDate.getMonth() + 1;
    const curDay = currentDate.getDate();

    let filingYear = targetYear;
    let filingMonth = targetMonth + 1;
    if (filingMonth > 12) {
        filingMonth = 1;
        filingYear += 1;
    }

    const deadline = `15.${String(filingMonth).padStart(2, '0')}.${filingYear}`;
    if (curYear < filingYear || (curYear === filingYear && curMonth < filingMonth)) {
        return {
            canSubmit: false,
            isTooEarly: true,
            isLate: false,
            isAutofillReady: false,
            deadline,
            message: `Подавать декларацию за ${String(targetMonth).padStart(2, '0')}.${targetYear} еще рано. Месяц еще не завершен. Срок подачи: с 01.${String(filingMonth).padStart(2, '0')}.${filingYear} по ${deadline}.`
        };
    }

    if (curYear === filingYear && curMonth === filingMonth) {
        if (curDay <= 5) {
            return {
                canSubmit: true,
                isTooEarly: false,
                isLate: false,
                isAutofillReady: false,
                deadline,
                message: `Период подачи открыт (до ${deadline}), но на портале rs.ge автозаполнение нарастающего итога начинает работать после 5 числа. Рекомендуется подождать 6-го числа.`
            };
        }
        if (curDay <= 15) {
            return {
                canSubmit: true,
                isTooEarly: false,
                isLate: false,
                isAutofillReady: true,
                deadline,
                message: `Оптимальный период для подачи декларации (дедлайн ${deadline}). Автозаполнение на RS.GE активно.`
            };
        }
        return {
            canSubmit: true,
            isTooEarly: false,
            isLate: true,
            isAutofillReady: true,
            deadline,
            message: `Внимание: срок подачи декларации за ${targetMonth}.${targetYear} истек ${deadline}. Декларацию необходимо подать как можно быстрее для минимизации штрафа/пени.`
        };
    }

    return {
        canSubmit: true,
        isTooEarly: false,
        isLate: true,
        isAutofillReady: true,
        deadline,
        message: `Просроченная декларация за ${targetMonth}.${targetYear} (дедлайн был ${deadline}).`
    };
}

/**
 * Статья 90 Налогового кодекса Грузии: ставка 3% применяется ко всему
 * облагаемому доходу начиная с начала месяца превышения годового лимита.
 */
function calculateSmallBusinessTax(incomeGel, cumulativeIncomeBefore = 0, options = {}) {
    const annualLimit = Number(options.annualLimit || STANDARD_ANNUAL_LIMIT);
    const newCumulative = cumulativeIncomeBefore + incomeGel;
    const isOverLimit = newCumulative > annualLimit;
    const rate = isOverLimit ? 0.03 : 0.01;

    return {
        rate,
        taxAmount: Number((incomeGel * rate).toFixed(2)),
        cumulativeTotal: Number(newCumulative.toFixed(2)),
        isOverLimit,
        annualLimit
    };
}

module.exports = {
    STANDARD_ANNUAL_LIMIT,
    TOURISM_ANNUAL_LIMIT,
    checkSubmissionPeriod,
    calculateSmallBusinessTax
};
