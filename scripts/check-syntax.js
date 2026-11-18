const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRECTORIES = [
    'config',
    'connectors',
    'core',
    'domain',
    'infrastructure',
    'modules',
    'scripts',
    'services',
    'test',
    'workflows'
];

function listJavaScriptFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) return listJavaScriptFiles(absolutePath);
        return entry.isFile() && entry.name.endsWith('.js') ? [absolutePath] : [];
    });
}

const files = [path.join(ROOT, 'index.js')].concat(
    SOURCE_DIRECTORIES.flatMap((directory) => listJavaScriptFiles(path.join(ROOT, directory)))
);

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
