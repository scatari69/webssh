'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { utils } = require('ssh2');

const config = require('../config');
const { getDb } = require('../db');
const secretbox = require('../crypto/secretbox');

const PASSPHRASE_CONTEXT = 'ssh_config:passphrase:1';
const KEY_FILENAME = 'host_key';

/** Типы ключей, которые принимаем. ecdsa приходит бесплатно вместе с ssh2. */
const ALLOWED_KEY_TYPES = /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-)/;

function keyPath() {
  return path.join(config.ssh.keysDir, KEY_FILENAME);
}

function row() {
  return getDb().prepare('SELECT * FROM ssh_config WHERE id = 1').get();
}

/**
 * Представление для API. Приватного ключа и passphrase здесь нет и быть не
 * может: наружу уходит только отпечаток публичной части, тип ключа и факт
 * наличия passphrase. Это отдельная функция, а не фильтрация row() по месту
 * использования, — чтобы «случайно отдать всё» требовало осознанных усилий.
 */
function getPublic() {
  const cfg = row();
  const updatedBy = cfg.updated_by
    ? getDb().prepare('SELECT username FROM users WHERE id = ?').get(cfg.updated_by)
    : null;

  return {
    host: cfg.host,
    port: cfg.port,
    ssh_username: cfg.ssh_username,
    has_private_key: Boolean(cfg.private_key_path),
    private_key_fingerprint: cfg.private_key_fingerprint,
    private_key_type: cfg.private_key_type,
    has_passphrase: Boolean(cfg.passphrase_enc),
    host_key_policy: cfg.host_key_policy,
    known_host_fingerprint: cfg.known_host_fingerprint,
    is_configured: Boolean(cfg.host && cfg.ssh_username && cfg.private_key_path),
    updated_at: cfg.updated_at,
    updated_by: updatedBy ? updatedBy.username : null,
  };
}

function fingerprintOf(parsedKey) {
  const digest = crypto.createHash('sha256').update(parsedKey.getPublicSSH()).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * Сообщения ssh2 сопоставлены с кодами ошибок API. Различать «ключ битый»,
 * «нужна passphrase» и «passphrase неверная» важно: администратор иначе не
 * поймёт, что именно чинить.
 */
function classifyParseError(message) {
  if (/no passphrase given/i.test(message)) return 'passphrase_required';
  if (/bad passphrase|failed to generate information to decrypt/i.test(message)) {
    return 'passphrase_invalid';
  }
  return 'private_key_invalid';
}

/**
 * @returns {{key: object}|{error: string}}
 */
function parsePrivateKey(keyText, passphrase) {
  let parsed;
  try {
    parsed = utils.parseKey(keyText, passphrase || undefined);
  } catch (err) {
    return { error: classifyParseError(err.message) };
  }
  if (parsed instanceof Error) return { error: classifyParseError(parsed.message) };

  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || typeof key.getPublicSSH !== 'function') return { error: 'private_key_invalid' };
  if (!ALLOWED_KEY_TYPES.test(key.type)) return { error: 'private_key_type_unsupported' };

  return { key };
}

/**
 * Запись ключа: сначала во временный файл с правами 0600, затем rename.
 * Прямая запись поверх оставила бы окно, в котором файл уже усечён, но ещё
 * не заполнен, — и обрыв в этот момент означал бы потерю ключа.
 */
function writeKeyFile(keyText) {
  fs.mkdirSync(config.ssh.keysDir, { recursive: true, mode: 0o700 });

  const target = keyPath();
  const tmp = `${target}.tmp.${crypto.randomBytes(6).toString('hex')}`;

  fs.writeFileSync(tmp, keyText, { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  return target;
}

function readKeyFile() {
  const cfg = row();
  if (!cfg.private_key_path) return null;
  try {
    return fs.readFileSync(cfg.private_key_path, 'utf8');
  } catch {
    return null;
  }
}

function currentPassphrase() {
  const cfg = row();
  if (!cfg.passphrase_enc) return null;
  return secretbox.openString(cfg.passphrase_enc, PASSPHRASE_CONTEXT);
}

const HOST_PATTERN = /^[A-Za-z0-9._-]+$|^\[?[0-9A-Fa-f:.]+\]?$/;
const SSH_USERNAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

function validateFields({ host, port, ssh_username: sshUsername }) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255 || !HOST_PATTERN.test(host)) {
    return 'host_invalid';
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port_invalid';
  if (
    typeof sshUsername !== 'string' ||
    sshUsername.length === 0 ||
    sshUsername.length > 32 ||
    !SSH_USERNAME_PATTERN.test(sshUsername)
  ) {
    return 'ssh_username_invalid';
  }
  return null;
}

/**
 * Обновление конфигурации.
 *
 * Семантика полей ключа намеренно трёхзначная:
 *   поле отсутствует  → не менять
 *   строка            → установить
 *   null (passphrase) → удалить
 * Иначе форма админки, не показывающая текущий ключ, не смогла бы
 * отправить «оставить как есть», не зная его.
 *
 * @returns {{ok: true, config: object, changed: object}|{ok: false, error: string}}
 */
function update(payload, actorId) {
  const fieldsError = validateFields(payload);
  if (fieldsError) return { ok: false, error: fieldsError };

  const cfg = row();

  const replacingKey = typeof payload.private_key === 'string' && payload.private_key.trim().length > 0;
  const passphraseProvided = Object.prototype.hasOwnProperty.call(payload, 'passphrase');
  const clearingPassphrase = passphraseProvided && (payload.passphrase === null || payload.passphrase === '');

  if (passphraseProvided && payload.passphrase !== null && typeof payload.passphrase !== 'string') {
    return { ok: false, error: 'passphrase_invalid' };
  }

  // Какой passphrase будет действовать после этого обновления.
  let effectivePassphrase;
  if (clearingPassphrase) effectivePassphrase = null;
  else if (passphraseProvided) effectivePassphrase = payload.passphrase;
  else effectivePassphrase = cfg.passphrase_enc ? currentPassphrase() : null;

  // Ключ проверяется, если меняется он сам или passphrase к нему: иначе
  // невалидная пара обнаружилась бы только при первом подключении.
  let keyText = null;
  let parsedKey = null;

  if (replacingKey) {
    keyText = payload.private_key;
  } else if (passphraseProvided && cfg.private_key_path) {
    keyText = readKeyFile();
    if (keyText === null) return { ok: false, error: 'private_key_missing' };
  }

  if (keyText !== null) {
    const result = parsePrivateKey(keyText, effectivePassphrase);
    if (result.error) return { ok: false, error: result.error };
    parsedKey = result.key;
  }

  const now = new Date().toISOString();
  const changed = {
    host: cfg.host !== payload.host,
    port: cfg.port !== payload.port,
    ssh_username: cfg.ssh_username !== payload.ssh_username,
    private_key: replacingKey,
    passphrase: passphraseProvided,
  };

  // Смена адреса означает другой сервер, а значит и другой ключ хоста.
  // Сохранённый ключ здесь обязан обнулиться: иначе первое же подключение
  // к новому адресу упрётся в «несовпадение ключа», и выбраться из этого
  // штатными средствами будет нельзя.
  const movedToAnotherHost = changed.host || changed.port;
  changed.known_host_key = movedToAnotherHost && Boolean(cfg.known_host_key);

  // Файл пишем до транзакции: откатить запись в файловой системе нельзя,
  // поэтому порядок такой, что при сбое БД на диске остаётся уже
  // проверенный валидный ключ, а не полуфабрикат.
  let storedKeyPath = cfg.private_key_path;
  if (replacingKey) {
    storedKeyPath = writeKeyFile(keyText);
  }

  const passphraseEnc = clearingPassphrase
    ? null
    : passphraseProvided
      ? secretbox.sealString(payload.passphrase, PASSPHRASE_CONTEXT)
      : cfg.passphrase_enc;

  getDb()
    .prepare(
      `UPDATE ssh_config
          SET host = ?, port = ?, ssh_username = ?,
              private_key_path = ?, private_key_fingerprint = ?, private_key_type = ?,
              passphrase_enc = ?, known_host_key = ?, known_host_fingerprint = ?,
              updated_at = ?, updated_by = ?
        WHERE id = 1`
    )
    .run(
      payload.host,
      payload.port,
      payload.ssh_username,
      storedKeyPath,
      parsedKey && replacingKey ? fingerprintOf(parsedKey) : cfg.private_key_fingerprint,
      parsedKey && replacingKey ? parsedKey.type : cfg.private_key_type,
      passphraseEnc,
      movedToAnotherHost ? null : cfg.known_host_key,
      movedToAnotherHost ? null : cfg.known_host_fingerprint,
      now,
      actorId ?? null
    );

  return { ok: true, config: getPublic(), changed };
}

/**
 * Секреты для установления SSH-соединения. Отдельный тип возврата, никогда
 * не пересекающийся с getPublic(): по этой функции легко искать все места,
 * где ключ вообще покидает хранилище.
 */
function loadConnectionSecrets() {
  const cfg = row();
  if (!cfg.private_key_path) return null;

  return {
    host: cfg.host,
    port: cfg.port,
    username: cfg.ssh_username,
    privateKey: fs.readFileSync(cfg.private_key_path),
    passphrase: cfg.passphrase_enc ? secretbox.openString(cfg.passphrase_enc, PASSPHRASE_CONTEXT) : null,
  };
}

module.exports = {
  getPublic,
  /**
   * Строка целиком, включая политику проверки ключа хоста и таймауты.
   * Секретов не содержит (passphrase здесь зашифрована), но и наружу
   * отдавать её нельзя — только для внутренних нужд подключения.
   */
  rawRow: row,
  update,
  loadConnectionSecrets,
  parsePrivateKey,
  fingerprintOf,
  keyPath,
  PASSPHRASE_CONTEXT,
};
