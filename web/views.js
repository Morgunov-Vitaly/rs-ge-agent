const {
    MONTH_NAMES_RU,
    formatReportPeriod,
    getPreviousReportPeriod
} = require('../domain/reporting-period');

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function money(value) {
    return new Intl.NumberFormat('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(Number(value || 0));
}

function russianCount(count, one, few, many) {
    const absolute = Math.abs(Number(count));
    const lastTwo = absolute % 100;
    const last = absolute % 10;
    const word = lastTwo >= 11 && lastTwo <= 14
        ? many
        : (last === 1 ? one : (last >= 2 && last <= 4 ? few : many));
    return `${count} ${word}`;
}

function icon(name) {
    const paths = {
        shield: '<path d="M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6l-7-3Z"/><path d="m9.5 12 1.7 1.7 3.6-4"/>',
        arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
        refresh: '<path d="M20 6v5h-5"/><path d="M19 11a7 7 0 1 0-1.7 6.8"/>',
        lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
        check: '<path d="m5 12 4 4L19 6"/>',
        alert: '<path d="M12 4 3 20h18L12 4Z"/><path d="M12 9v5M12 17h.01"/>',
        table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>'
    };
    return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}

function layout({ title, body, session, pageClass = '' }) {
    const navigation = session
        ? `<header class="topbar">
            <a class="brand" href="/" aria-label="RS.GE Agent, главная">
                <span class="brand-mark">RS</span>
                <span><strong>RS.GE Agent</strong><small>Налоговый контроль</small></span>
            </a>
            <div class="topbar-actions">
                <span class="read-only-badge">${icon('shield')} Только чтение</span>
                <form method="post" action="/logout">
                    <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
                    <button class="button button-quiet" type="submit">Выйти</button>
                </form>
            </div>
        </header>`
        : '';
    return `<!doctype html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(title)} · RS.GE Agent</title>
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/assets/styles.css">
    <script src="/assets/app.js" defer></script>
</head>
<body class="${escapeHtml(pageClass)}">
    ${navigation}
    ${body}
</body>
</html>`;
}

function loginView({ csrfToken, error = '', username = '' }) {
    return layout({
        title: 'Вход',
        pageClass: 'login-page',
        body: `<main class="login-shell">
            <section class="login-intro" aria-labelledby="login-title">
                <div class="brand brand-login">
                    <span class="brand-mark">RS</span>
                    <span><strong>RS.GE Agent</strong><small>Налоговый контроль</small></span>
                </div>
                <div>
                    <p class="eyebrow">Self-hosted контроль</p>
                    <h1 id="login-title">Налоговый период без догадок</h1>
                    <p class="lead">Сверяйте декларацию, оплату и задолженность с данными учета в одном защищенном интерфейсе.</p>
                </div>
                <ul class="trust-list">
                    <li>${icon('shield')} Данные остаются на вашем сервере</li>
                    <li>${icon('check')} Проверка не изменяет RS.GE и таблицу</li>
                    <li>${icon('lock')} SMS-код обрабатывается только на сервере</li>
                </ul>
            </section>
            <section class="login-panel" aria-label="Вход в Web-интерфейс">
                <div>
                    <p class="eyebrow">Защищенный доступ</p>
                    <h2>Войти в кабинет</h2>
                    <p>Используйте отдельные данные Web-интерфейса. Это не логин RS.GE.</p>
                </div>
                ${error ? `<div class="notice notice-error" role="alert">${icon('alert')}<span>${escapeHtml(error)}</span></div>` : ''}
                <form class="form-stack" method="post" action="/login">
                    <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
                    <label>Имя пользователя
                        <input name="username" autocomplete="username" value="${escapeHtml(username)}" required autofocus>
                    </label>
                    <label>Пароль
                        <input name="password" type="password" autocomplete="current-password" required>
                    </label>
                    <button class="button button-primary button-wide" type="submit">Войти ${icon('arrow')}</button>
                </form>
                <p class="fine-print">Сессия автоматически завершится после периода бездействия.</p>
            </section>
        </main>`
    });
}

function periodOptions(selectedYear, selectedMonth, now = new Date()) {
    const latest = getPreviousReportPeriod(now);
    const options = [];
    for (let offset = 0; offset < 24; offset += 1) {
        const date = new Date(latest.year, latest.month - 1 - offset, 1);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        options.push(`<option value="${year}-${month}" ${year === selectedYear && month === selectedMonth ? 'selected' : ''}>${escapeHtml(MONTH_NAMES_RU[month - 1])} ${year}</option>`);
    }
    return options.join('');
}

function sheetStatus(summary) {
    if (summary.isFiled && summary.isPaid) return { tone: 'positive', label: 'В учете закрыт' };
    if (summary.recordsCount === 0) return { tone: 'neutral', label: 'Нет записей' };
    return { tone: 'warning', label: 'Нужна проверка' };
}

function historyRows(history) {
    if (!history.length) {
        return `<tr><td colspan="5" class="empty-cell">История появится после добавления доходов в Google Sheets.</td></tr>`;
    }
    return history.map((item) => `<tr>
        <td><a href="/?year=${item.year}&month=${item.month}">${escapeHtml(item.label)}</a><small>${russianCount(item.recordsCount, 'запись', 'записи', 'записей')}</small></td>
        <td class="numeric">${money(item.incomeGel)} <span>GEL</span></td>
        <td class="numeric">${money(item.taxGel)} <span>GEL</span></td>
        <td><span class="status-dot ${item.isPaid ? 'status-positive' : 'status-muted'}"></span>${item.isPaid ? `Оплачен ${escapeHtml(item.paymentDate)}` : 'Не отмечен'}</td>
        <td>${escapeHtml(item.status)}</td>
    </tr>`).join('');
}

function dashboardView({ session, dashboard, error = '', now = new Date() }) {
    const { period, summary, yearSummary, history } = dashboard;
    const status = sheetStatus(summary);
    return layout({
        title: `Период ${period.key}`,
        session,
        body: `<main class="app-shell">
            <section class="page-heading">
                <div>
                    <p class="eyebrow">Обзор учета</p>
                    <h1>Налоговый период</h1>
                    <p>Google Sheets показывает плановые суммы. Для подтверждения состояния запустите безопасную проверку RS.GE.</p>
                </div>
                <form class="period-picker" method="get" action="/">
                    <label for="period">Период</label>
                    <select id="period" name="period" data-period-select>${periodOptions(period.year, period.month, now)}</select>
                    <noscript><button class="button button-secondary" type="submit">Показать</button></noscript>
                </form>
            </section>
            ${error ? `<div class="notice notice-error" role="alert">${icon('alert')}<span>${escapeHtml(error)}</span></div>` : ''}
            <section class="period-overview" aria-labelledby="period-title">
                <div class="period-verdict">
                    <div class="period-verdict-top">
                        <span class="status-pill status-${status.tone}">${escapeHtml(status.label)}</span>
                        <span class="source-label">Источник: Google Sheets</span>
                    </div>
                    <div>
                        <p class="eyebrow">${escapeHtml(period.label)}</p>
                        <h2 id="period-title">Данные учета готовы к сверке</h2>
                        <p>Проверка сопоставит декларацию, фактическую оплату и баланс личной карточки. Никакие данные не будут изменены.</p>
                    </div>
                    <form method="post" action="/checks" class="check-form">
                        <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
                        <input type="hidden" name="year" value="${period.year}">
                        <input type="hidden" name="month" value="${period.month}">
                        <button class="button button-primary" type="submit">${icon('refresh')} Проверить аккаунт</button>
                        <span>Обычно занимает до минуты. Может потребоваться SMS.</span>
                    </form>
                </div>
                <div class="ledger" aria-label="Суммы по данным учета">
                    <div class="ledger-row ledger-primary">
                        <span>Доход за месяц</span>
                        <strong>${money(summary.totalIncomeGel)} <small>GEL</small></strong>
                    </div>
                    <div class="ledger-row">
                        <span>Налог по таблице</span>
                        <strong>${money(summary.totalTaxGel)} <small>GEL</small></strong>
                    </div>
                    <div class="ledger-row">
                        <span>Доход с начала ${period.year}</span>
                        <strong>${money(yearSummary.totalIncomeGel)} <small>GEL</small></strong>
                    </div>
                    <div class="ledger-row ledger-meta">
                        <span>${russianCount(summary.recordsCount, 'запись', 'записи', 'записей')}</span>
                        <span>${escapeHtml(summary.status)}</span>
                    </div>
                </div>
            </section>
            <section class="history-section" aria-labelledby="history-title">
                <div class="section-heading">
                    <div>
                        <p class="eyebrow">Журнал</p>
                        <h2 id="history-title">История периодов</h2>
                    </div>
                    <span class="source-label">${icon('table')} Google Sheets</span>
                </div>
                <div class="table-wrap">
                    <table>
                        <thead><tr><th>Период</th><th class="numeric">Доход</th><th class="numeric">Налог</th><th>Оплата</th><th>Декларация</th></tr></thead>
                        <tbody>${historyRows(history)}</tbody>
                    </table>
                </div>
            </section>
        </main>`
    });
}

function reportHtml(report) {
    const lines = String(report || '').split('\n');
    const items = [];
    let inList = false;
    for (const line of lines) {
        if (line.startsWith('• ')) {
            if (!inList) {
                items.push('<ul class="report-list">');
                inList = true;
            }
            items.push(`<li>${escapeHtml(line.slice(2))}</li>`);
        } else {
            if (inList) {
                items.push('</ul>');
                inList = false;
            }
            if (line.trim()) items.push(`<p>${escapeHtml(line)}</p>`);
        }
    }
    if (inList) items.push('</ul>');
    return items.join('');
}

function operationView({ session, operation }) {
    const waitingSms = operation.status === 'awaiting_sms';
    const pending = operation.status === 'starting' || operation.status === 'checking';
    const completed = operation.status === 'completed';
    const failed = operation.status === 'failed';
    const result = operation.result;
    const statusClass = completed
        ? (result.verdict === 'closed' ? 'positive' : 'warning')
        : (failed ? 'danger' : 'info');
    const heading = waitingSms
        ? 'Введите код из SMS'
        : (pending
            ? (operation.status === 'starting' ? 'Входим в RS.GE' : 'Сверяем данные')
            : (completed ? (result.verdict === 'closed' ? `Период ${result.period} закрыт` : `Период ${result.period} требует внимания`) : 'Проверка не завершена'));
    const body = waitingSms
        ? `<form class="sms-form" method="post" action="/operations/${escapeHtml(operation.id)}/sms">
            <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}">
            <label for="sms-code">Код подтверждения RS.GE</label>
            <input id="sms-code" class="sms-input" name="code" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="one-time-code" required autofocus>
            <button class="button button-primary" type="submit">Продолжить ${icon('arrow')}</button>
            <p>Код не сохраняется и не попадает в журнал. Ожидание: 5 минут.</p>
        </form>`
        : (pending
            ? `<div class="progress-track" aria-label="Проверка выполняется"><span></span></div>
               <p class="operation-help">Не закрывайте страницу. Статус обновится автоматически.</p>`
            : (failed
                ? `<div class="notice notice-error" role="alert">${icon('alert')}<span>${escapeHtml(operation.error)}</span></div>
                   <a class="button button-secondary" href="/">Вернуться к обзору</a>`
                : `<div class="result-ledger">
                    <div><span>Доход</span><strong>${money(result.incomeGel)} GEL</strong></div>
                    <div><span>Налог</span><strong>${money(result.taxGel)} GEL</strong></div>
                    <div><span>Оплата</span><strong>${result.paymentSatisfied ? 'Подтверждена' : 'Требует проверки'}</strong></div>
                    <div><span>Задолженность</span><strong>${result.balance ? `${money(result.balance.debt)} GEL` : 'Нет данных'}</strong></div>
                </div>
                <div class="report-block">${reportHtml(result.report)}</div>
                ${result.needsReconciliation ? '<div class="notice notice-warning"><span>Расхождения можно будет записать через Telegram после отдельного подтверждения. Web-версия пока работает только в режиме чтения.</span></div>' : ''}
                <a class="button button-secondary" href="/?year=${operation.year}&month=${operation.month}">Вернуться к периоду</a>`));
    return layout({
        title: heading,
        session,
        body: `<main class="operation-shell" ${pending || waitingSms ? `data-operation-id="${escapeHtml(operation.id)}" data-operation-status="${escapeHtml(operation.status)}"` : ''}>
            <a class="back-link" href="/?year=${operation.year}&month=${operation.month}">← Обзор периода ${formatReportPeriod(operation.year, operation.month)}</a>
            <section class="operation-card">
                <div class="operation-icon status-${statusClass}">${completed && result.verdict === 'closed' ? icon('check') : (failed ? icon('alert') : icon('refresh'))}</div>
                <p class="eyebrow">Безопасная проверка · READ_ONLY</p>
                <h1>${escapeHtml(heading)}</h1>
                <p class="lead">${waitingSms ? 'RS.GE отправил одноразовый код на привязанный телефон.' : (pending ? 'Читаем данные портала и сравниваем их с Google Sheets.' : 'Проверка завершена без изменения данных на портале и в таблице.')}</p>
                ${body}
            </section>
        </main>`
    });
}

function errorView({ session, statusCode, title, message }) {
    return layout({
        title,
        session,
        body: `<main class="operation-shell">
            <section class="operation-card error-page">
                <p class="eyebrow">Ошибка ${statusCode}</p>
                <h1>${escapeHtml(title)}</h1>
                <p class="lead">${escapeHtml(message)}</p>
                <a class="button button-secondary" href="/">Вернуться на главную</a>
            </section>
        </main>`
    });
}

module.exports = {
    dashboardView,
    errorView,
    escapeHtml,
    loginView,
    money,
    operationView,
    periodOptions,
    reportHtml
};
