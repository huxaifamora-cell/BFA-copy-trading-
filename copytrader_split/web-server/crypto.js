/**
 * crypto.js — AES-256-GCM encryption for stored MT5 credentials
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN   = 32;
const IV_LEN    = 16;
const ENCODING  = 'hex';

function getKey() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('ENCRYPTION_SECRET must be at least 32 characters');
  return crypto.scryptSync(secret, 'copytrader-salt', KEY_LEN);
}

function encrypt(plaintext) {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString(ENCODING), tag.toString(ENCODING), encrypted.toString(ENCODING)].join(':');
}

function decrypt(encoded) {
  const key = getKey();
  const [ivHex, tagHex, dataHex] = encoded.split(':');
  const iv        = Buffer.from(ivHex,  ENCODING);
  const tag       = Buffer.from(tagHex, ENCODING);
  const encrypted = Buffer.from(dataHex, ENCODING);
  const decipher  = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
