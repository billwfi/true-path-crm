const crypto = require('crypto');

// Symmetric encryption for SFTP secrets at rest.
// Key: env IMPORT_CRYPT_KEY = 64 hex chars (32 bytes). The Python worker
// (scripts/import_worker.py) uses the same key + format to decrypt.
// Stored format: "v1:<iv hex>:<tag hex>:<ciphertext hex>" (AES-256-GCM).

function getKey() {
  const hex = process.env.IMPORT_CRYPT_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('IMPORT_CRYPT_KEY must be set to 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

function decrypt(blob) {
  if (!blob) return null;
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('bad ciphertext format');
  const [, ivHex, tagHex, ctHex] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
