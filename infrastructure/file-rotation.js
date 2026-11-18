const fs = require('fs');
const path = require('path');

function archiveName(filePath, now = new Date()) {
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    let candidate = `${filePath}.${timestamp}`;
    let counter = 1;
    while (fs.existsSync(candidate)) {
        candidate = `${filePath}.${timestamp}.${counter}`;
        counter += 1;
    }
    return candidate;
}

function appendRotatingFile(filePath, line, options = {}) {
    const now = options.now || new Date();
    const maxBytes = options.maxBytes || 10 * 1024 * 1024;
    const rotationIntervalMs = options.rotationIntervalMs || 24 * 60 * 60 * 1000;
    const lineBytes = Buffer.byteLength(line);
    let rotatedPath = null;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    try {
        const stats = fs.statSync(filePath);
        const exceedsSize = stats.size > 0 && stats.size + lineBytes > maxBytes;
        const exceedsAge = stats.size > 0 && now.getTime() - stats.mtimeMs >= rotationIntervalMs;
        if (exceedsSize || exceedsAge) {
            rotatedPath = archiveName(filePath, now);
            fs.renameSync(filePath, rotatedPath);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    fs.appendFileSync(filePath, line, { mode: 0o600 });
    return rotatedPath;
}

module.exports = {
    appendRotatingFile,
    archiveName
};
