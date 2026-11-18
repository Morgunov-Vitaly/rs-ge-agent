const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FORBIDDEN_PATHS = [
    /^\.env$/,
    /^google-credentials\.json$/,
    /^session_state\.json$/,
    /^(logs|screenshots|output)\//
];
const CONTENT_RULES = [
    {
        name: 'private key',
        pattern: new RegExp(['BEGIN', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY'].join(' '))
    },
    {
        name: 'Telegram bot token',
        pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/
    },
    {
        name: 'Google service-account private key',
        pattern: new RegExp(['["\']', 'private', '_key["\']\\s*:'].join(''))
    }
];

function gitFiles() {
    const commonArgs = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
    let result = spawnSync('git', commonArgs, { cwd: ROOT, encoding: 'utf8' });

    if (result.status !== 0 && fs.existsSync(path.join(ROOT, '.git-local'))) {
        result = spawnSync('git', ['--git-dir=.git-local', ...commonArgs], {
            cwd: ROOT,
            encoding: 'utf8'
        });
    }

    if (result.status !== 0) {
        throw new Error(`Unable to enumerate publishable files: ${result.stderr.trim()}`);
    }
    return result.stdout.split('\0').filter(Boolean);
}

const findings = [];
for (const relativePath of gitFiles()) {
    const normalizedPath = relativePath.replaceAll(path.sep, '/');
    if (FORBIDDEN_PATHS.some((pattern) => pattern.test(normalizedPath))) {
        findings.push(`${normalizedPath}: forbidden runtime file`);
        continue;
    }

    const absolutePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size > 2_000_000) continue;
    const content = fs.readFileSync(absolutePath, 'utf8');
    for (const rule of CONTENT_RULES) {
        if (rule.pattern.test(content)) findings.push(`${normalizedPath}: possible ${rule.name}`);
    }
}

if (findings.length > 0) {
    console.error('Potential secrets or private runtime files detected:');
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
}

console.log('Secret scan passed. No forbidden publishable files or known secret patterns found.');
