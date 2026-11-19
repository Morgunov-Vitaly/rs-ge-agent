const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateSmallBusinessTax } = require('../domain/small-business');

test('uses 1% while annual income remains within the standard limit', () => {
    const result = calculateSmallBusinessTax(10000, 480000);

    assert.equal(result.rate, 0.01);
    assert.equal(result.taxAmount, 100);
    assert.equal(result.isOverLimit, false);
    assert.equal(result.annualLimit, 500000);
});

test('uses 3% for the entire month in which the annual limit is exceeded', () => {
    const result = calculateSmallBusinessTax(30000, 480000);

    assert.equal(result.cumulativeTotal, 510000);
    assert.equal(result.rate, 0.03);
    assert.equal(result.taxAmount, 900);
    assert.equal(result.isOverLimit, true);
});

test('supports a 700,000 GEL profile limit where legally applicable', () => {
    const beforeLimit = calculateSmallBusinessTax(10000, 680000, { annualLimit: 700000 });
    const crossingLimit = calculateSmallBusinessTax(30000, 680000, { annualLimit: 700000 });

    assert.equal(beforeLimit.taxAmount, 100);
    assert.equal(crossingLimit.taxAmount, 900);
    assert.equal(crossingLimit.annualLimit, 700000);
});

test('rounds half-tetri tax amounts up instead of using binary toFixed rounding', () => {
    const result = calculateSmallBusinessTax(2000.5, 10000);
    assert.equal(result.taxAmount, 20.01);
});
