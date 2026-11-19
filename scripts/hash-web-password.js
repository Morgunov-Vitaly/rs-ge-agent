const crypto = require('crypto');
const { hashPassword } = require('../web/security');

async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
}

async function main() {
    const fromStdin = process.argv.includes('--stdin');
    const password = fromStdin
        ? await readStdin()
        : crypto.randomBytes(18).toString('base64url');
    const encoded = await hashPassword(password);

    if (!fromStdin) {
        console.log('Сохраните пароль в менеджере паролей. Он показывается только сейчас:');
        console.log(password);
        console.log('');
    }
    console.log(`WEB_PASSWORD_HASH='${encoded}'`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
