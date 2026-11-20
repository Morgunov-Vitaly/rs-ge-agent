(() => {
    const select = document.querySelector('[data-period-select]');
    if (select) {
        select.addEventListener('change', () => {
            const [year, month] = select.value.split('-');
            window.location.assign(`/?year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`);
        });
    }

    const ledgerSelect = document.querySelector('[data-ledger-period-select]');
    if (ledgerSelect) {
        ledgerSelect.addEventListener('change', () => {
            window.location.assign(`/ledger?period=${encodeURIComponent(ledgerSelect.value)}`);
        });
    }

    const operation = document.querySelector('[data-operation-id]');
    if (!operation) return;
    const operationId = operation.dataset.operationId;
    let previousStatus = operation.dataset.operationStatus;
    const poll = async () => {
        try {
            const response = await fetch(`/api/operations/${encodeURIComponent(operationId)}`, {
                headers: { Accept: 'application/json' }
            });
            if (!response.ok) return;
            const payload = await response.json();
            if (payload.status !== previousStatus) {
                window.location.reload();
                return;
            }
        } catch {
            // The visible page remains usable; the next poll may recover.
        }
        window.setTimeout(poll, 1500);
    };
    window.setTimeout(poll, 800);
})();
