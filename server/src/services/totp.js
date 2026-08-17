'use strict';

const config = require('../config');
const totp = require('../auth/totp');
const secretbox = require('../crypto/secretbox');
const { getDb } = require('../db');

/**
 * Контекст шифрования привязывает секрет к строке конкретного пользователя:
 * переставить чужой блоб в свою запись не выйдет, расшифровка не пройдёт.
 */
function secretContext(userId) {
  return `users:totp_secret:${userId}`;
}

/**
 * Двухфакторка обязательна для администраторов (TOTP_REQUIRED_FOR_ADMIN) и
 * добровольна для остальных: приложение выдаёт шелл на общий хост, и права
 * администратора здесь — это в том числе возможность подменить SSH-ключ.
 */
function isRequiredFor(user) {
  return user.role === 'admin' && config.totp.requiredForAdmin;
}

/** Нужен ли этому пользователю второй фактор при входе прямо сейчас. */
function isChallengeNeeded(user) {
  return Boolean(user.totp_enabled) || isRequiredFor(user);
}

function loadSecret(user) {
  if (!user.totp_secret_enc) return null;
  return secretbox.openString(user.totp_secret_enc, secretContext(user.id));
}

/**
 * Начало привязки: секрет сохраняется сразу, но totp_enabled остаётся 0 —
 * пока пользователь не подтвердил кодом, что приложение-аутентификатор
 * действительно его получило. Иначе можно было бы запереть себя, сохранив
 * секрет и потеряв его.
 */
function startEnrollment(user) {
  const secret = totp.createSecret();

  getDb()
    .prepare('UPDATE users SET totp_secret_enc = ?, totp_enabled = 0, totp_confirmed_at = NULL, updated_at = ? WHERE id = ?')
    .run(secretbox.sealString(secret, secretContext(user.id)), new Date().toISOString(), user.id);

  return { secret, uri: totp.buildUri(secret, user.username) };
}

function replaceRecoveryCodes(userId) {
  const codes = totp.generateRecoveryCodes();
  const db = getDb();

  db.transaction(() => {
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
    for (const code of codes) insert.run(userId, totp.hashRecoveryCode(code));
  })();

  return codes;
}

/**
 * Завершение привязки. Возвращает коды восстановления — единственный раз,
 * когда они видны: в базе лежат только их хеши.
 *
 * @returns {{ok: true, recoveryCodes: string[]}|{ok: false, error: string}}
 */
function confirmEnrollment(user, code) {
  const secret = loadSecret(user);
  if (!secret) return { ok: false, error: 'totp_not_started' };
  if (user.totp_enabled) return { ok: false, error: 'totp_already_enabled' };

  const result = totp.verifyToken(secret, code);
  if (!result.valid) return { ok: false, error: 'totp_code_invalid' };

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE users
          SET totp_enabled = 1, totp_confirmed_at = ?, totp_last_step = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(now, result.timeStep, now, user.id);

  return { ok: true, recoveryCodes: replaceRecoveryCodes(user.id) };
}

/**
 * Проверка второго фактора. Принимает либо код из приложения, либо код
 * восстановления — по формату они не пересекаются (шесть цифр против
 * шестнадцати букв и цифр).
 *
 * @returns {{ok: true, method: 'totp'|'recovery', recoveryRemaining: number}
 *          |{ok: false, error: string}}
 */
function verifyChallenge(user, code) {
  if (!user.totp_enabled) return { ok: false, error: 'totp_not_enabled' };

  if (totp.isWellFormedToken(code)) {
    const secret = loadSecret(user);
    if (!secret) return { ok: false, error: 'totp_not_enabled' };

    const result = totp.verifyToken(secret, code);
    if (!result.valid) return { ok: false, error: 'totp_code_invalid' };

    // Код действует ~90 секунд. Без этой проверки подсмотренный код можно
    // предъявить второй раз, пока окно не закрылось.
    if (user.totp_last_step !== null && result.timeStep <= user.totp_last_step) {
      return { ok: false, error: 'totp_code_reused' };
    }

    getDb().prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(result.timeStep, user.id);

    return { ok: true, method: 'totp', recoveryRemaining: countRecoveryCodes(user.id) };
  }

  return consumeRecoveryCode(user, code);
}

function countRecoveryCodes(userId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .get(userId).count;
}

/**
 * Код восстановления одноразовый: помечается использованным в той же
 * транзакции, в которой найден, — иначе два одновременных запроса приняли
 * бы один и тот же код дважды.
 */
function consumeRecoveryCode(user, code) {
  const normalized = totp.normalizeRecoveryCode(code);
  if (normalized.length === 0) return { ok: false, error: 'totp_code_invalid' };

  const db = getDb();
  const consumed = db.transaction(() => {
    const row = db
      .prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
      .get(user.id, totp.hashRecoveryCode(normalized));

    if (!row) return false;

    db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    return true;
  })();

  if (!consumed) return { ok: false, error: 'totp_code_invalid' };

  return { ok: true, method: 'recovery', recoveryRemaining: countRecoveryCodes(user.id) };
}

/** Полный сброс: и секрет, и коды восстановления. */
function reset(userId) {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE users
          SET totp_secret_enc = NULL, totp_enabled = 0, totp_confirmed_at = NULL,
              totp_last_step = NULL, updated_at = ?
        WHERE id = ?`
    ).run(new Date().toISOString(), userId);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  })();
}

module.exports = {
  isRequiredFor,
  isChallengeNeeded,
  startEnrollment,
  confirmEnrollment,
  verifyChallenge,
  replaceRecoveryCodes,
  countRecoveryCodes,
  reset,
  secretContext,
};
