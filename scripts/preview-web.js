const { loadConfig } = require('../config');
const { hashPassword } = require('../web/security');
const { startWebServer } = require('../web/server');

const records = [
    { date: '2026-10-04', amountGel: 3105, taxGel: 31.05, paymentDate: '17.11.2026', status: 'Подана' },
    { date: '2026-10-18', amountGel: 4172.76, taxGel: 41.73, paymentDate: '17.11.2026', status: 'Подана' },
    { date: '2026-09-12', amountGel: 6840.5, taxGel: 68.41, paymentDate: '15.10.2026', status: 'Подана' },
    { date: '2026-08-15', amountGel: 5920, taxGel: 59.2, paymentDate: '16.09.2026', status: 'Подана' }
];

function forMonth(year, month) {
    return records.filter((record) => {
        const [recordYear, recordMonth] = record.date.split('-').map(Number);
        return recordYear === year && recordMonth === month;
    });
}

async function main() {
    const passwordHash = await hashPassword('preview-access-only', 'preview-fixed-salt');
    const port = Number(process.env.WEB_PREVIEW_PORT || 4173);
    const appConfig = loadConfig({
        WEB_ENABLED: 'true',
        WEB_HOST: '127.0.0.1',
        WEB_PORT: String(port),
        WEB_USERNAME: 'preview',
        WEB_PASSWORD_HASH: passwordHash,
        WEB_SESSION_SECRET: 'preview-session-secret-is-long-enough',
        WEB_COOKIE_SECURE: 'false'
    });
    const recordsRepository = {
        async getIncomeRecords() {
            return records;
        },
        async getMonthlySummary(year, month) {
            const selected = forMonth(year, month);
            const income = selected.reduce((sum, record) => sum + record.amountGel, 0);
            const tax = selected.reduce((sum, record) => sum + record.taxGel, 0);
            return {
                year,
                month,
                recordsCount: selected.length,
                totalIncomeGel: Number(income.toFixed(2)),
                totalTaxGel: Number(tax.toFixed(2)),
                status: selected.length ? 'Подана' : 'Нет записей',
                isFiled: selected.length > 0,
                isPaid: selected.length > 0
            };
        },
        async getYearlySummary(year, throughMonth) {
            const selected = records.filter((record) => {
                const [recordYear, recordMonth] = record.date.split('-').map(Number);
                return recordYear === year && recordMonth <= throughMonth;
            });
            return {
                totalIncomeGel: selected.reduce((sum, record) => sum + record.amountGel, 0)
            };
        }
    };
    const runtime = await startWebServer({
        appConfig,
        recordsRepository,
        loginToRsGe: async (requestSms) => {
            await requestSms();
            await new Promise((resolve) => setTimeout(resolve, 500));
            return { page: {}, browser: { close: async () => undefined } };
        },
        createRsGeClient: () => ({}),
        accountCheck: async ({ year, month }) => ({
            period: `${String(month).padStart(2, '0')}.${year}`,
            verdict: 'closed',
            report: `✅ Период ${String(month).padStart(2, '0')}.${year} закрыт\n\nДекларация RS.GE: Sent\nОплата: подтверждена 17.11.2026\nЛичная карточка: задолженность 0.00 GEL, переплата 0.22 GEL\n\nИстория оплат:\n• Совпадает: 3 записи\n• Расхождение даты: 0 записей\n\nПроверка выполнена в режиме чтения. Данные не изменялись.`,
            summary: { totalIncomeGel: 7277.76, totalTaxGel: 72.78, status: 'Подана' },
            declaration: { exists: true, status: 'Sent', metadata: { submittedAt: '14.11.2026' } },
            portalHistory: { balance: { debt: 0, overpayment: 0.22 } },
            paymentSatisfied: true,
            debtClear: true,
            issueCount: 0,
            counts: { matched: 3, dateMismatch: 0, amountMismatch: 0, missingOnPortal: 0 },
            needsReconciliation: false
        }),
        appLogger: console,
        now: () => new Date('2026-11-19T12:00:00+04:00')
    });
    console.log(`Web preview: http://127.0.0.1:${port}`);
    console.log('Login: preview / preview-access-only');

    const close = async () => {
        await runtime.close();
        process.exit(0);
    };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
