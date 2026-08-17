'use strict';

const crypto = require('node:crypto');

const config = require('../config');

/**
 * Симметричное шифрование секретов, лежащих в БД: passphrase от SSH-ключа и
 * TOTP-секреты. Мастер-ключ живёт в окружении/docker secret и в базу не
 * попадает никогда — файл БД сам по себе бесполезен без него.
 *
 * Формат блоба:
 *   [version:1][keyId:1][nonce:12][ciphertext:N][tag:16]
 *
 * version позволит сменить алгоритм, keyId — сменить ключ, не переписывая
 * разом всю базу: новые записи пишутся текущим ключом, старые ещё читаются
 * предыдущим (ENCRYPTION_KEY_PREVIOUS).
 */

const VERSION = 1;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 2 + NONCE_LENGTH;

const keyring = new Map([[config.secrets.encryptionKeyId, config.secrets.encryptionKey]]);
if (config.secrets.previousEncryptionKey) {
  keyring.set(config.secrets.previousEncryptionKeyId, config.secrets.previousEncryptionKey);
}

/**
 * AAD привязывает шифротекст к конкретному полю конкретной строки. Без этого
 * блоб можно было бы переставить из одного столбца в другой — например,
 * подменить TOTP-секрет админа значением из своей же строки, — и расшифровка
 * прошла бы успешно.
 */
function buildAad(context) {
  if (!context || typeof context !== 'string') {
    throw new TypeError('secretbox: context обязателен и должен быть строкой');
  }
  return Buffer.from(context, 'utf8');
}

/**
 * @param {string|Buffer} plaintext
 * @param {string} context например 'ssh_config:passphrase:1' или 'users:totp_secret:42'
 * @returns {Buffer}
 */
function seal(plaintext, context) {
  const aad = buildAad(context);
  const keyId = config.secrets.encryptionKeyId;
  const key = keyring.get(keyId);
  const nonce = crypto.randomBytes(NONCE_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
  cipher.setAAD(aad);

  const input = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([VERSION, keyId]), nonce, ciphertext, tag]);
}

/**
 * @param {Buffer} blob
 * @param {string} context тот же, что при seal()
 * @returns {Buffer}
 */
function open(blob, context) {
  if (!Buffer.isBuffer(blob) || blob.length < HEADER_LENGTH + TAG_LENGTH) {
    throw new Error('secretbox: некорректный блоб');
  }

  const version = blob[0];
  if (version !== VERSION) {
    throw new Error(`secretbox: неподдерживаемая версия формата (${version})`);
  }

  const keyId = blob[1];
  const key = keyring.get(keyId);
  if (!key) {
    throw new Error(
      `secretbox: нет ключа с id=${keyId}. Если это старый ключ, укажите его ` +
        'в ENCRYPTION_KEY_PREVIOUS / ENCRYPTION_KEY_PREVIOUS_ID.'
    );
  }

  const nonce = blob.subarray(2, HEADER_LENGTH);
  const ciphertext = blob.subarray(HEADER_LENGTH, blob.length - TAG_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
  decipher.setAAD(buildAad(context));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Удобная обёртка для секретов, которые логически являются строками. */
function sealString(value, context) {
  return seal(value, context);
}

function openString(blob, context) {
  const buf = open(blob, context);
  const value = buf.toString('utf8');
  buf.fill(0);
  return value;
}

/** true, если блоб зашифрован не текущим ключом и подлежит перешифровке. */
function needsRotation(blob) {
  return Buffer.isBuffer(blob) && blob.length > 1 && blob[1] !== config.secrets.encryptionKeyId;
}

module.exports = { seal, open, sealString, openString, needsRotation, VERSION };
