'use strict';

const session = require('express-session');

const config = require('../config');
const { getDb } = require('../db');

const BaseSqliteStore = require('better-sqlite3-session-store')(session);

/**
 * Стор переопределён ради одной строки: базовый класс создаёт setInterval
 * для чистки протухших сессий и не сохраняет его хендл, из-за чего таймер
 * держит event loop и процесс не завершается (в тестах — навсегда).
 */
class SqliteSessionStore extends BaseSqliteStore {
  startInterval() {
    this.cleanupTimer = setInterval(() => this.clearExpiredSessions(), this.expired.intervalMs);
    this.cleanupTimer.unref();
  }

  stopInterval() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

/**
 * Префикс __Host- требует Secure и Path=/; по http браузер такую cookie
 * отбросит, поэтому в разработке имя без префикса.
 */
function sessionCookieName() {
  return config.isProduction ? '__Host-webssh.sid' : 'webssh.sid';
}

function createSessionMiddleware() {
  const store = new SqliteSessionStore({
    client: getDb(),
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  });

  const secure = config.isProduction;

  const middleware = session({
    store,
    secret: config.secrets.sessionSecret,
    resave: false,
    // Не создавать запись в сторе для анонимов: иначе каждый запрос бота
    // на страницу логина оставляет строку в БД.
    saveUninitialized: false,
    // Скользящее окно: активность продлевает сессию, простой — нет.
    rolling: true,
    name: sessionCookieName(),
    proxy: true,
    cookie: {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: config.session.idleTimeoutMs,
    },
  });

  middleware.store = store;
  return middleware;
}

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function save(req) {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

function destroy(req) {
  return new Promise((resolve, reject) => req.session.destroy((err) => (err ? reject(err) : resolve())));
}

/**
 * Полноценная сессия после успешного прохождения всех факторов.
 * Идентификатор перевыпускается: тот, что мог быть подсунут до входа,
 * становится бесполезным (защита от фиксации сессии).
 */
async function establishSession(req, user) {
  await regenerate(req);
  req.session.user = { id: user.id, username: user.username, role: user.role };
  req.session.createdAt = Date.now();
  await save(req);
}

/**
 * Промежуточное состояние между паролем и вторым фактором. Полноценной
 * сессии здесь нет — requireAuth такую не пропустит, — только отметка о
 * том, чей пароль уже проверен.
 */
async function establishMfaChallenge(req, user) {
  await regenerate(req);
  req.session.pendingMfa = { userId: user.id, since: Date.now() };
  await save(req);
}

module.exports = {
  createSessionMiddleware,
  sessionCookieName,
  establishSession,
  establishMfaChallenge,
  regenerate,
  save,
  destroy,
  SqliteSessionStore,
};
