'use strict';

const config = require('../config');
const { getDb } = require('../db');

/**
 * Поля, безопасные для выдачи наружу. password_hash и totp_secret_enc сюда
 * не входят никогда — список задан явно, а не через SELECT *, чтобы новая
 * секретная колонка не утекла в API самим фактом своего появления.
 */
const PUBLIC_COLUMNS = `id, username, role, is_active, totp_enabled, totp_confirmed_at,
                        last_login_at, password_changed_at, created_at, updated_at`;

const NOW = () => new Date().toISOString();

function list() {
  return getDb().prepare(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY username COLLATE NOCASE`).all();
}

function findPublicById(id) {
  return getDb().prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id);
}

/** Полная строка, включая хеш пароля. Только для проверки входа. */
function findByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

function findById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function usernameTaken(username) {
  return Boolean(
    getDb().prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)
  );
}

function create({ username, passwordHash, role, createdBy }) {
  const now = NOW();
  const info = getDb()
    .prepare(
      `INSERT INTO users (username, password_hash, role, is_active, password_changed_at,
                          created_at, updated_at, created_by)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
    )
    .run(username, passwordHash, role, now, now, now, createdBy ?? null);
  return findPublicById(info.lastInsertRowid);
}

function countActiveAdmins() {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1")
    .get();
  return row.count;
}

function setActive(id, isActive) {
  getDb()
    .prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?')
    .run(isActive ? 1 : 0, NOW(), id);
  return findPublicById(id);
}

/**
 * Сброс пароля администратором. password_changed_at сдвигается вперёд, и по
 * этой отметке инвалидируются уже открытые сессии пользователя: смена пароля
 * должна выкидывать того, кто мог им пользоваться.
 */
function setPassword(id, passwordHash) {
  const now = NOW();
  getDb()
    .prepare(
      `UPDATE users
          SET password_hash = ?, password_changed_at = ?, updated_at = ?,
              failed_login_count = 0, locked_until = NULL
        WHERE id = ?`
    )
    .run(passwordHash, now, now, id);
  return findPublicById(id);
}

function recordLoginSuccess(id) {
  getDb()
    .prepare(
      `UPDATE users SET last_login_at = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?`
    )
    .run(NOW(), id);
}

/**
 * Блокировка учётной записи после серии неудач. Дополняет заградительный
 * лимит по IP: тот держит флуд с одного адреса, эта — точечный подбор
 * пароля с меняющихся адресов. Задержка растёт экспоненциально, потолок —
 * час, чтобы блокировка не превращалась в способ навсегда лишить человека
 * доступа.
 */
function recordLoginFailure(id) {
  const db = getDb();
  const row = db.prepare('SELECT failed_login_count FROM users WHERE id = ?').get(id);
  const failures = (row ? row.failed_login_count : 0) + 1;

  let lockedUntil = null;
  if (failures >= config.access.loginLockoutThreshold) {
    const overshoot = failures - config.access.loginLockoutThreshold;
    const delayMs = Math.min(60_000 * 2 ** overshoot, 60 * 60_000);
    lockedUntil = new Date(Date.now() + delayMs).toISOString();
  }

  db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?').run(
    failures,
    lockedUntil,
    id
  );

  return { failures, lockedUntil };
}

function isLocked(user) {
  return Boolean(user.locked_until) && new Date(user.locked_until).getTime() > Date.now();
}

/** Представление пользователя для API-ответов. */
function toPublic(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    is_active: Boolean(user.is_active),
    totp_enabled: Boolean(user.totp_enabled),
    totp_confirmed_at: user.totp_confirmed_at ?? null,
    last_login_at: user.last_login_at ?? null,
    created_at: user.created_at,
    updated_at: user.updated_at ?? null,
  };
}

module.exports = {
  list,
  findById,
  findPublicById,
  findByUsername,
  usernameTaken,
  create,
  countActiveAdmins,
  setActive,
  setPassword,
  recordLoginSuccess,
  recordLoginFailure,
  isLocked,
  toPublic,
};
