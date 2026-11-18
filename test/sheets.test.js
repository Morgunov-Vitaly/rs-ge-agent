const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNumber, parseRecordPeriod } = require('../services/sheets');

test('parseNumber supports formatted Google Sheets values', () => {
    assert.equal(parseNumber('7,277.76'), 7277.76);
    assert.equal(parseNumber('7.277,76'), 7277.76);
    assert.equal(parseNumber('7277,76'), 7277.76);
    assert.equal(parseNumber('72.78'), 72.78);
    assert.equal(parseNumber('2,075.95'), 2075.95);
});

test('parseRecordPeriod accepts supported dates and rejects invalid dates', () => {
    assert.deepEqual(
        parseRecordPeriod('31.10.2026'),
        { year: 2026, month: 10, day: 31, date: new Date(Date.UTC(2026, 9, 31)) }
    );
    assert.equal(parseRecordPeriod('2026-10-31').month, 10);
    assert.equal(parseRecordPeriod('32.10.2026'), null);
    assert.equal(parseRecordPeriod(''), null);
});
