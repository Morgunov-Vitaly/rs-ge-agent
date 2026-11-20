const Busboy = require('busboy');
const { MAX_FILE_BYTES } = require('./ledger-file');

function uploadError(message, code = 'INVALID_UPLOAD') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function readLedgerUpload(request) {
    return new Promise((resolve, reject) => {
        let parser;
        try {
            parser = Busboy({ headers: request.headers, limits: {
                fileSize: MAX_FILE_BYTES, files: 1, fields: 2, parts: 3
            } });
        } catch {
            reject(uploadError('Выберите CSV или XLSX и повторите загрузку.'));
            return;
        }
        let csrf = '';
        let file = null;
        let failure = null;
        parser.on('field', (name, value) => {
            if (name === 'csrf') csrf = value;
        });
        parser.on('file', (name, stream, info) => {
            const chunks = [];
            let size = 0;
            stream.on('data', (chunk) => {
                size += chunk.length;
                if (size <= MAX_FILE_BYTES) chunks.push(chunk);
            });
            stream.on('limit', () => { failure = uploadError('Файл превышает 2 МБ.', 'BODY_TOO_LARGE'); });
            stream.on('end', () => {
                if (name !== 'file') failure ||= uploadError('Поле с файлом не найдено.');
                file = { filename: info.filename, buffer: Buffer.concat(chunks) };
            });
        });
        parser.on('filesLimit', () => { failure ||= uploadError('Загрузите один файл.'); });
        parser.on('fieldsLimit', () => { failure ||= uploadError('Слишком много полей формы.'); });
        parser.on('partsLimit', () => { failure ||= uploadError('Слишком много частей формы.'); });
        parser.on('error', reject);
        parser.on('finish', () => {
            if (failure) reject(failure);
            else if (!file) reject(uploadError('Выберите файл CSV или XLSX.'));
            else resolve({ csrf, ...file });
        });
        request.on('error', reject);
        request.pipe(parser);
    });
}

module.exports = { readLedgerUpload };
