const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config: defaultConfig } = require('../config');

const ENCRYPTION_MAGIC = Buffer.from('RSGE-EVIDENCE-1\n', 'utf8');

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validatePeriod(year, month) {
    if (!Number.isInteger(year) || year < 2016 || !Number.isInteger(month) || month < 1 || month > 12) {
        const error = new Error('Некорректный период evidence artifact');
        error.code = 'INVALID_EVIDENCE_PERIOD';
        throw error;
    }
}

function requireBuffer(value, name) {
    if (!Buffer.isBuffer(value) || value.length === 0) {
        const error = new Error(`Evidence artifact ${name} отсутствует или пуст`);
        error.code = 'INVALID_EVIDENCE_ARTIFACT';
        throw error;
    }
    return value;
}

async function writePrivateFile(filePath, contents) {
    await fs.promises.writeFile(filePath, contents, { mode: 0o600, flag: 'wx' });
    await fs.promises.chmod(filePath, 0o600);
}

function parseEncryptionKey(value) {
    const key = Buffer.isBuffer(value)
        ? value
        : Buffer.from(String(value || '').trim(), 'base64');
    if (key.length !== 32) {
        const error = new Error(
            'RSGE_EVIDENCE_KEY должен содержать 32 байта в base64. ' +
            'Сгенерируйте его: openssl rand -base64 32'
        );
        error.code = 'EVIDENCE_ENCRYPTION_KEY_REQUIRED';
        throw error;
    }
    return key;
}

function encryptArtifact(buffer, encryptionKey) {
    const key = parseEncryptionKey(encryptionKey);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([ENCRYPTION_MAGIC, iv, tag, ciphertext]);
}

function decryptArtifact(encryptedBuffer, encryptionKey) {
    const key = parseEncryptionKey(encryptionKey);
    if (!Buffer.isBuffer(encryptedBuffer) ||
        !encryptedBuffer.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) {
        const error = new Error('Неизвестный формат evidence artifact');
        error.code = 'INVALID_EVIDENCE_FORMAT';
        throw error;
    }
    const ivStart = ENCRYPTION_MAGIC.length;
    const tagStart = ivStart + 12;
    const ciphertextStart = tagStart + 16;
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        encryptedBuffer.subarray(ivStart, tagStart)
    );
    decipher.setAuthTag(encryptedBuffer.subarray(tagStart, ciphertextStart));
    return Buffer.concat([
        decipher.update(encryptedBuffer.subarray(ciphertextStart)),
        decipher.final()
    ]);
}

class FileEvidenceStore {
    constructor(options = {}) {
        if (typeof options === 'string') options = { rootDir: options };
        this.rootDir = path.resolve(options.rootDir || defaultConfig.rsGe.evidenceDir);
        this.encryptionKey = options.encryptionKey ?? defaultConfig.rsGe.evidenceEncryptionKey;
    }

    async assertReady() {
        parseEncryptionKey(this.encryptionKey);
        await fs.promises.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        await fs.promises.chmod(this.rootDir, 0o700);
        await fs.promises.access(this.rootDir, fs.constants.R_OK | fs.constants.W_OK);
        return true;
    }

    async saveDeclarationSubmission(input) {
        const {
            year,
            month,
            screenshotBuffer,
            pdfBuffer,
            createdAt = new Date()
        } = input || {};
        validatePeriod(year, month);
        requireBuffer(screenshotBuffer, 'screenshot');
        requireBuffer(pdfBuffer, 'pdf');

        const period = `${String(month).padStart(2, '0')}.${year}`;
        const periodDirectory = path.join(
            this.rootDir,
            'declaration-submissions',
            `${year}-${String(month).padStart(2, '0')}`
        );
        await this.assertReady();
        await fs.promises.mkdir(periodDirectory, { recursive: true, mode: 0o700 });
        await fs.promises.chmod(periodDirectory, 0o700);

        const timestamp = createdAt.toISOString().replace(/[:.]/g, '-');
        const suffix = crypto.randomUUID().slice(0, 8);
        const baseName = `submission-${timestamp}-${suffix}`;
        const screenshotPath = path.join(periodDirectory, `${baseName}.png.enc`);
        const pdfPath = path.join(periodDirectory, `${baseName}.pdf.enc`);
        const manifestPath = path.join(periodDirectory, `${baseName}.json.enc`);

        const encryptedScreenshot = encryptArtifact(screenshotBuffer, this.encryptionKey);
        const encryptedPdf = encryptArtifact(pdfBuffer, this.encryptionKey);

        await writePrivateFile(screenshotPath, encryptedScreenshot);
        await writePrivateFile(pdfPath, encryptedPdf);

        const artifacts = [
            {
                type: 'screenshot',
                fileName: path.basename(screenshotPath),
                bytes: screenshotBuffer.length,
                sha256: sha256(screenshotBuffer),
                encryptedSha256: sha256(encryptedScreenshot)
            },
            {
                type: 'pdf',
                fileName: path.basename(pdfPath),
                bytes: pdfBuffer.length,
                sha256: sha256(pdfBuffer),
                encryptedSha256: sha256(encryptedPdf)
            }
        ];
        const manifest = {
            schemaVersion: 1,
            action: 'small-business.submit-declaration',
            period,
            createdAt: createdAt.toISOString(),
            artifacts
        };
        const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        await writePrivateFile(
            manifestPath,
            encryptArtifact(manifestBuffer, this.encryptionKey)
        );

        return Object.freeze({
            period,
            directory: periodDirectory,
            manifestPath,
            screenshotPath,
            pdfPath,
            artifacts: Object.freeze(artifacts.map((artifact) => Object.freeze(artifact)))
        });
    }
}

const evidenceStore = new FileEvidenceStore();

module.exports = {
    decryptArtifact,
    encryptArtifact,
    FileEvidenceStore,
    evidenceStore,
    parseEncryptionKey,
    sha256
};
