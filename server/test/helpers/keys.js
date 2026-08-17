'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Тестовые SSH-ключи генерируются на лету, а не лежат фикстурами в
 * репозитории: приватный ключ в git — даже одноразовый — это то, на что
 * справедливо ругаются сканеры секретов.
 *
 * ssh-keygen для этого не используется: тесты должны идти внутри
 * контейнера приложения (node:20-alpine), где его нет.
 */

/** RSA в формате PKCS#1 PEM — его ssh2 разбирает без дополнительных условий. */
function generateRsaPem() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
}

function sshString(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}

/**
 * Сборка незашифрованного ed25519 в формате OpenSSH («BEGIN OPENSSH PRIVATE
 * KEY») — именно в нём ssh-keygen выдаёт ed25519, и именно его должно
 * принимать приложение.
 *
 * Структура (PROTOCOL.key):
 *   "openssh-key-v1\0" ciphername kdfname kdfoptions nkeys pub priv-section
 */
function generateEd25519OpenSsh(comment = 'webssh-test') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });

  // DER-обёртки у ed25519 фиксированной длины: приватный PKCS#8 — 48 байт,
  // где последние 32 суть seed; публичный SPKI — 44 байта, последние 32 —
  // сам ключ. Длины проверяем, чтобы молча не собрать мусор.
  if (privateKey.length !== 48 || publicKey.length !== 44) {
    throw new Error(`Неожиданный размер DER: priv=${privateKey.length} pub=${publicKey.length}`);
  }
  const seed = privateKey.subarray(16);
  const pub = publicKey.subarray(12);

  const keyType = 'ssh-ed25519';
  const publicBlob = Buffer.concat([sshString(keyType), sshString(pub)]);

  const check = crypto.randomBytes(4);
  let privateSection = Buffer.concat([
    check,
    check,
    sshString(keyType),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);

  // Дополнение до кратности размеру блока (для ciphername "none" — 8)
  // байтами 1, 2, 3, …
  const blockSize = 8;
  const padLength = (blockSize - (privateSection.length % blockSize)) % blockSize;
  if (padLength > 0) {
    privateSection = Buffer.concat([
      privateSection,
      Buffer.from(Array.from({ length: padLength }, (_, i) => i + 1)),
    ]);
  }

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    (() => {
      const n = Buffer.alloc(4);
      n.writeUInt32BE(1);
      return n;
    })(),
    sshString(publicBlob),
    sshString(privateSection),
  ]);

  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/**
 * Зашифрованный ключ требует bcrypt_pbkdf, который вручную собирать в
 * тестах не стоит. Поэтому такие ключи берём у ssh-keygen, если он есть, а
 * если нет — соответствующие проверки пропускаются явно.
 */
function sshKeygenAvailable() {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // ssh-keygen на `-?` выходит с ненулевым кодом, но он существует.
    return err.code !== 'ENOENT';
  }
}

function generateEncryptedEd25519(passphrase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-key-'));
  const file = path.join(dir, 'k');
  try {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', file, '-N', passphrase, '-q']);
    return fs.readFileSync(file, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  generateRsaPem,
  generateEd25519OpenSsh,
  generateEncryptedEd25519,
  sshKeygenAvailable,
};
