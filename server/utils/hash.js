const crypto = require('crypto');
const fs = require('fs');

/**
 * Computes a SHA-256 hash of the exact bytes of a file on disk.
 * @param {string} filePath - Absolute or relative path to the file.
 * @returns {string} Hex-encoded SHA-256 digest.
 */
function hashFile(filePath) {
    const bytes = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

module.exports = { hashFile };
