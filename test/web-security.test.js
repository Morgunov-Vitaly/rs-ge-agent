const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createRateLimiter,
    createOneTimeTokenStore,
    createSessionStore,
    hashPassword,
    verifyPassword
} = require('../web/security');

test('web passwords use scrypt and reject invalid credentials', async () => {
    const encoded = await hashPassword('correct horse battery staple', 'fixed-test-salt');
    assert.match(encoded, /^scrypt\$fixed-test-salt\$/);
    assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
    assert.equal(await verifyPassword('wrong password', encoded), false);
    assert.equal(await verifyPassword('anything', 'invalid'), false);
    await assert.rejects(hashPassword('too-short'), /не менее 12/);
});

test('web sessions are signed, httpOnly and expire after inactivity', () => {
    let timestamp = 1_000;
    const store = createSessionStore({
        secret: 'a'.repeat(32),
        ttlMs: 5_000,
        secureCookies: true,
        now: () => timestamp
    });
    const created = store.create('owner');
    assert.match(created.cookie, /HttpOnly/);
    assert.match(created.cookie, /SameSite=Strict/);
    assert.match(created.cookie, /Secure/);

    const cookie = created.cookie.split(';')[0];
    const request = { headers: { cookie } };
    assert.equal(store.get(request).username, 'owner');

    const tampered = { headers: { cookie: `${cookie}x` } };
    assert.equal(store.get(tampered), null);

    timestamp += 5_001;
    assert.equal(store.get(request), null);
});

test('login rate limiter blocks attempts within a fixed window', () => {
    let timestamp = 10_000;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => timestamp });
    assert.equal(limiter.consume('client').allowed, true);
    assert.equal(limiter.consume('client').allowed, true);
    assert.equal(limiter.consume('client').allowed, false);
    timestamp += 1_001;
    assert.equal(limiter.consume('client').allowed, true);
});

test('pre-auth CSRF tokens are owner-bound, expiring and single-use', () => {
    let timestamp = 100;
    const tokens = createOneTimeTokenStore({ ttlMs: 1_000, now: () => timestamp });
    const first = tokens.create('127.0.0.1');
    assert.equal(tokens.consume(first, 'other-client'), false);
    assert.equal(tokens.consume(first, '127.0.0.1'), false);
    const second = tokens.create('127.0.0.1');
    assert.equal(tokens.consume(second, '127.0.0.1'), true);
    assert.equal(tokens.consume(second, '127.0.0.1'), false);
    const expired = tokens.create('127.0.0.1');
    timestamp += 1_001;
    assert.equal(tokens.consume(expired, '127.0.0.1'), false);
});
