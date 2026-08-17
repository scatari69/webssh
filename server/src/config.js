'use strict';

const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config();

/**
 * Конфигурация читается один раз при старте и валидируется целиком: процесс
 * либо поднимается с полным набором корректных значений, либо не поднимается
 * вовсе. Половинчатый старт хуже падения — приложение с пустым ENCRYPTION_KEY
 * выглядит рабочим ровно до момента, когда впервые понадобится расшифровать
 * секрет.
 */

const errors = [];

/**
 * Секреты можно подавать двумя способами: значением в переменной окружения
 * или путём к файлу (docker secrets). Файл предпочтительнее — содержимое
 * переменных видно в `docker inspect` и в /proc/<pid>/environ.
 */
function readSecret(name) {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      errors.push(`${name}_FILE: не удалось прочитать ${filePath} (${err.code})`);
      return '';
    }
  }
  return (process.env[name] || '').trim();
}

function str(name, fallback) {
  const value = (process.env[name] || '').trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  errors.push(`${name}: обязательная переменная не задана`);
  return '';
}

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name}: ожидалось целое в диапазоне ${min}..${max}, получено "${raw}"`);
    return fallback;
  }
  return value;
}

function bool(name, fallback) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function list(name) {
  return (process.env[name] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Мастер-ключ шифрования: ровно 32 байта после декодирования base64. */
function encryptionKey(name, { required }) {
  const raw = readSecret(name);
  if (!raw) {
    if (required) errors.push(`${name}: обязательная переменная не задана (openssl rand -base64 32)`);
    return null;
  }
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    errors.push(`${name}: значение не является корректным base64`);
    return null;
  }
  if (buf.length !== 32) {
    errors.push(`${name}: после декодирования base64 ожидалось 32 байта, получено ${buf.length}`);
    return null;
  }
  return buf;
}

const sessionSecret = readSecret('SESSION_SECRET');
if (!sessionSecret) {
  errors.push('SESSION_SECRET: обязательная переменная не задана (openssl rand -base64 48)');
} else if (sessionSecret.length < 32) {
  errors.push(`SESSION_SECRET: слишком короткий (${sessionSecret.length} символов, нужно ≥32)`);
}

const currentKey = encryptionKey('ENCRYPTION_KEY', { required: true });
const previousKey = encryptionKey('ENCRYPTION_KEY_PREVIOUS', { required: false });
const previousKeyId = int('ENCRYPTION_KEY_PREVIOUS_ID', null, { min: 1, max: 255 });

if (previousKey && !previousKeyId) {
  errors.push('ENCRYPTION_KEY_PREVIOUS_ID: обязателен, когда задан ENCRYPTION_KEY_PREVIOUS');
}

const config = {
  env: str('NODE_ENV', 'production'),
  port: int('PORT', 3000, { min: 1, max: 65535 }),
  publicOrigin: str('PUBLIC_ORIGIN', 'http://localhost:3000').replace(/\/+$/, ''),

  db: {
    path: str('DB_PATH', '/data/webssh.sqlite'),
  },

  ssh: {
    keysDir: str('SSH_KEYS_DIR', '/keys'),
  },

  secrets: {
    sessionSecret,
    encryptionKey: currentKey,
    encryptionKeyId: int('ENCRYPTION_KEY_ID', 1, { min: 1, max: 255 }),
    previousEncryptionKey: previousKey,
    previousEncryptionKeyId: previousKeyId,
  },

  session: {
    idleTimeoutMs: int('SESSION_IDLE_TIMEOUT_MS', 8 * 60 * 60 * 1000, { min: 60_000 }),
    absoluteTimeoutMs: int('SESSION_ABSOLUTE_TIMEOUT_MS', 7 * 24 * 60 * 60 * 1000, { min: 60_000 }),
  },

  totp: {
    requiredForAdmin: bool('TOTP_REQUIRED_FOR_ADMIN', true),
    issuer: str('TOTP_ISSUER', 'webssh'),
  },

  limits: {
    maxSessionsPerUser: int('MAX_SESSIONS_PER_USER', 3, { min: 1 }),
    maxSessionsTotal: int('MAX_SESSIONS_TOTAL', 50, { min: 1 }),
    idleTimeoutMs: int('IDLE_TIMEOUT_MS', 30 * 60 * 1000, { min: 60_000 }),
    detachGraceMs: int('DETACH_GRACE_MS', 120_000, { min: 0 }),
    replayBufferBytes: int('REPLAY_BUFFER_BYTES', 256 * 1024, { min: 0 }),
    /*
     * Потолок размера одного кадра WebSocket. Библиотека ws буферизует кадр
     * целиком, прежде чем отдать его нам, поэтому это единственное место,
     * где память ограничивается до того, как будет израсходована: без
     * потолка любой клиент занимает столько, сколько пришлёт.
     *
     * 64 КиБ выбраны по назначению канала: это ввод человека и вставка из
     * буфера обмена. Осмысленная вставка в терминал такого размера — уже
     * редкость, а всё, что больше, разумнее передать через scp.
     */
    wsMaxMessageBytes: int('WS_MAX_MESSAGE_BYTES', 64 * 1024, { min: 1024, max: 4 * 1024 * 1024 }),
  },

  access: {
    ipAllowlist: list('IP_ALLOWLIST'),
    loginRateWindowMs: int('LOGIN_RATE_WINDOW_MS', 15 * 60 * 1000, { min: 1000 }),
    loginRateMaxAttempts: int('LOGIN_RATE_MAX_ATTEMPTS', 10, { min: 1 }),
    loginLockoutThreshold: int('LOGIN_LOCKOUT_THRESHOLD', 5, { min: 1 }),
  },

  audit: {
    retentionDays: int('AUDIT_RETENTION_DAYS', 365, { min: 1 }),
  },

  bootstrap: {
    adminUsername: str('ADMIN_INITIAL_USERNAME', 'admin'),
    adminPassword: readSecret('ADMIN_INITIAL_PASSWORD'),
  },
};

config.isProduction = config.env === 'production';

/**
 * Приложение работает исключительно за Caddy, поэтому реальный IP берётся из
 * X-Forwarded-For. Доверяем ровно одному прокси: если доверять произвольному
 * заголовку, любой сможет подделать адрес и обойти и rate limit, и блокировку
 * по IP — то есть обесценить всю защиту от перебора.
 */
config.trustProxyHops = 1;

if (config.session.absoluteTimeoutMs < config.session.idleTimeoutMs) {
  errors.push('SESSION_ABSOLUTE_TIMEOUT_MS не может быть меньше SESSION_IDLE_TIMEOUT_MS');
}

if (config.isProduction && !config.publicOrigin.startsWith('https://')) {
  errors.push(
    `PUBLIC_ORIGIN: в production ожидается https:// (получено "${config.publicOrigin}"). ` +
      'Cookie сессии выставляется с флагом Secure и по http работать не будет.'
  );
}

if (errors.length > 0) {
  console.error('Конфигурация некорректна, старт невозможен:');
  for (const message of errors) console.error(`  • ${message}`);
  console.error('\nСм. .env.example — там описаны все переменные и способы их получить.');
  process.exit(1);
}

config.db.dir = path.dirname(config.db.path);

module.exports = config;
