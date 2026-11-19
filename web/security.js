const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const SESSION_COOKIE = 'rsge_session';

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('base64url')) {
    if (!password || String(password).length < 12) {
        throw new Error('Пароль Web-интерфейса должен содержать не менее 12 символов');
    }
    const digest = await scryptAsync(String(password), salt, 64);
    return `scrypt$${salt}$${Buffer.from(digest).toString('base64url')}`;
}

async function verifyPassword(password, encodedHash) {
    const [algorithm, salt, expected] = String(encodedHash || '').split('$');
    if (algorithm !== 'scrypt' || !salt || !expected) return false;
    const actual = Buffer.from(await scryptAsync(String(password || ''), salt, 64));
    const expectedBuffer = Buffer.from(expected, 'base64url');
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function parseCookies(request) {
    return Object.fromEntries(
        String(request.headers.cookie || '')
            .split(';')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const index = part.indexOf('=');
                return index === -1
                    ? [part, '']
                    : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
            })
    );
}

function cookieOptions({ maxAgeSeconds, secure, httpOnly = true }) {
    return [
        'Path=/',
        `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
        'SameSite=Strict',
        httpOnly ? 'HttpOnly' : '',
        secure ? 'Secure' : ''
    ].filter(Boolean).join('; ');
}

function createSessionStore({ secret, ttlMs, secureCookies, now = () => Date.now() }) {
    const sessions = new Map();

    function sign(id) {
        return crypto.createHmac('sha256', secret).update(id).digest('base64url');
    }

    function serialize(id) {
        return `${id}.${sign(id)}`;
    }

    function parse(value) {
        const separator = String(value || '').lastIndexOf('.');
        if (separator < 1) return null;
        const id = value.slice(0, separator);
        return safeEqual(value.slice(separator + 1), sign(id)) ? id : null;
    }

    function create(username) {
        const id = crypto.randomBytes(32).toString('base64url');
        const timestamp = now();
        const session = {
            id,
            username,
            csrfToken: crypto.randomBytes(32).toString('base64url'),
            createdAt: timestamp,
            lastSeenAt: timestamp
        };
        sessions.set(id, session);
        return {
            session,
            cookie: `${SESSION_COOKIE}=${encodeURIComponent(serialize(id))}; ${cookieOptions({
                maxAgeSeconds: ttlMs / 1000,
                secure: secureCookies
            })}`
        };
    }

    function get(request) {
        const id = parse(parseCookies(request)[SESSION_COOKIE]);
        if (!id) return null;
        const session = sessions.get(id);
        if (!session) return null;
        if (now() - session.lastSeenAt > ttlMs) {
            sessions.delete(id);
            return null;
        }
        session.lastSeenAt = now();
        return session;
    }

    function destroy(request) {
        const id = parse(parseCookies(request)[SESSION_COOKIE]);
        if (id) sessions.delete(id);
    }

    function cleanup() {
        const timestamp = now();
        for (const [id, session] of sessions) {
            if (timestamp - session.lastSeenAt > ttlMs) sessions.delete(id);
        }
    }

    return Object.freeze({
        create,
        get,
        destroy,
        cleanup,
        clearCookie: `${SESSION_COOKIE}=; ${cookieOptions({ maxAgeSeconds: 0, secure: secureCookies })}`
    });
}

function createOneTimeTokenStore({ ttlMs, now = () => Date.now() }) {
    const tokens = new Map();
    return Object.freeze({
        create(owner) {
            const token = crypto.randomBytes(32).toString('base64url');
            tokens.set(token, { owner, expiresAt: now() + ttlMs });
            return token;
        },
        consume(token, owner) {
            const record = tokens.get(String(token || ''));
            tokens.delete(String(token || ''));
            return Boolean(record && record.owner === owner && record.expiresAt >= now());
        },
        cleanup() {
            const timestamp = now();
            for (const [token, record] of tokens) {
                if (record.expiresAt < timestamp) tokens.delete(token);
            }
        }
    });
}

function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
    const buckets = new Map();
    return Object.freeze({
        consume(key) {
            const timestamp = now();
            const current = buckets.get(key);
            const bucket = !current || timestamp - current.startedAt >= windowMs
                ? { startedAt: timestamp, count: 0 }
                : current;
            bucket.count += 1;
            buckets.set(key, bucket);
            return {
                allowed: bucket.count <= limit,
                retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (timestamp - bucket.startedAt)) / 1000))
            };
        },
        reset(key) {
            buckets.delete(key);
        }
    });
}

async function readForm(request, maxBytes = 16 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) {
            const error = new Error('Request body is too large');
            error.code = 'BODY_TOO_LARGE';
            throw error;
        }
        chunks.push(chunk);
    }
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

function setSecurityHeaders(response) {
    response.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "base-uri 'none'",
        "connect-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "img-src 'self' data:",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self'"
    ].join('; '));
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    response.setHeader('Cache-Control', 'no-store');
}

module.exports = {
    SESSION_COOKIE,
    createOneTimeTokenStore,
    createRateLimiter,
    createSessionStore,
    hashPassword,
    parseCookies,
    readForm,
    setSecurityHeaders,
    verifyPassword
};
