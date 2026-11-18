function parseRecordPeriod(date) {
    if (!date) return null;

    const value = String(date).trim();
    let year;
    let month;
    let day;

    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        [year, month, day] = value.split('-').map(Number);
    } else if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(value)) {
        [day, month, year] = value.split('.').map(Number);
    } else {
        return null;
    }

    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() + 1 !== month ||
        parsed.getUTCDate() !== day
    ) {
        return null;
    }

    return { year, month, day, date: parsed };
}

module.exports = { parseRecordPeriod };
