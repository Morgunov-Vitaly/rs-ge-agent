const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    decryptArtifact,
    FileEvidenceStore,
    sha256
} = require('../infrastructure/evidence-store');

test('stores private submission evidence with SHA-256 manifest', async () => {
    const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rs-ge-evidence-'));
    const screenshotBuffer = Buffer.from('screenshot proof');
    const pdfBuffer = Buffer.from('pdf proof');
    const encryptionKey = Buffer.alloc(32, 7).toString('base64');
    const store = new FileEvidenceStore({ rootDir, encryptionKey });

    try {
        const result = await store.saveDeclarationSubmission({
            year: 2026,
            month: 10,
            screenshotBuffer,
            pdfBuffer,
            createdAt: new Date('2026-11-19T12:00:00.000Z')
        });
        const encryptedManifest = await fs.promises.readFile(result.manifestPath);
        const encryptedScreenshot = await fs.promises.readFile(result.screenshotPath);
        const encryptedPdf = await fs.promises.readFile(result.pdfPath);
        const manifest = JSON.parse(
            decryptArtifact(encryptedManifest, encryptionKey).toString('utf8')
        );

        assert.equal(manifest.period, '10.2026');
        assert.equal(manifest.artifacts[0].sha256, sha256(screenshotBuffer));
        assert.equal(manifest.artifacts[1].sha256, sha256(pdfBuffer));
        assert.deepEqual(decryptArtifact(encryptedScreenshot, encryptionKey), screenshotBuffer);
        assert.deepEqual(decryptArtifact(encryptedPdf, encryptionKey), pdfBuffer);
        assert.equal(encryptedScreenshot.includes(screenshotBuffer), false);
        assert.equal(encryptedPdf.includes(pdfBuffer), false);
        assert.equal((await fs.promises.stat(result.screenshotPath)).mode & 0o777, 0o600);
        assert.equal((await fs.promises.stat(result.pdfPath)).mode & 0o777, 0o600);
        assert.equal((await fs.promises.stat(result.manifestPath)).mode & 0o777, 0o600);
    } finally {
        await fs.promises.rm(rootDir, { recursive: true, force: true });
    }
});

test('refuses to store evidence without a 32-byte encryption key', async () => {
    const store = new FileEvidenceStore({ rootDir: os.tmpdir(), encryptionKey: '' });
    await assert.rejects(
        store.assertReady(),
        ({ code }) => code === 'EVIDENCE_ENCRYPTION_KEY_REQUIRED'
    );
});
