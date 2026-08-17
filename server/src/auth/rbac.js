'use strict';

const config = require('../config');
const users = require('../services/users');

/**
 * Состояние пользователя перечитывается из БД на каждом запросе, а не
 * берётся из cookie. Это лишний (дешёвый, better-sqlite3 синхронный)
 * запрос, но благодаря ему деактивация учётной записи и сброс пароля
 * действуют немедленно, а не после истечения cookie.
 */
function resolveSessionUser(req) {
  const sessionUser = req.session && req.session.user;
  if (!sessionUser || !sessionUser.id) return { error: 'unauthenticated' };

  const createdAt = req.session.createdAt || 0;

  if (config.session.absoluteTimeoutMs > 0 && Date.now() - createdAt > config.session.absoluteTimeoutMs) {
    return { error: 'session_expired' };
  }

  const user = users.findById(sessionUser.id);
  if (!user) return { error: 'unauthenticated' };
  if (!user.is_active) return { error: 'account_disabled' };

  // Сессия, открытая до смены пароля, больше не действительна: сброс
  // пароля администратором должен выкидывать того, кто мог им пользоваться.
  if (user.password_changed_at && new Date(user.password_changed_at).getTime() > createdAt) {
    return { error: 'session_expired' };
  }

  return { user };
}

const STATUS = {
  unauthenticated: 401,
  session_expired: 401,
  account_disabled: 403,
};

function requireAuth(req, res, next) {
  const { user, error } = resolveSessionUser(req);

  if (error) {
    // Недействительную сессию уничтожаем, чтобы клиент не ходил с ней дальше.
    if (error !== 'unauthenticated' && req.session) {
      return req.session.destroy(() => res.status(STATUS[error]).json({ error }));
    }
    return res.status(STATUS[error]).json({ error });
  }

  req.user = user;
  return next();
}

function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }
    return next();
  });
}

/**
 * Промежуточная сессия «пароль принят, второй фактор ещё нет» живёт
 * недолго: она не даёт доступа к API, но позволяет привязать или
 * подтвердить TOTP, и висеть сутками ей незачем.
 */
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function resolvePendingUser(req) {
  const pending = req.session && req.session.pendingMfa;
  if (!pending || !pending.userId) return { error: 'unauthenticated' };

  if (Date.now() - pending.since > MFA_CHALLENGE_TTL_MS) return { error: 'mfa_challenge_expired' };

  const user = users.findById(pending.userId);
  if (!user) return { error: 'unauthenticated' };
  if (!user.is_active) return { error: 'account_disabled' };

  return { user };
}

const PENDING_STATUS = {
  unauthenticated: 401,
  mfa_challenge_expired: 401,
  account_disabled: 403,
};

/** Только для незавершённого входа: подтверждение второго фактора. */
function requirePendingMfa(req, res, next) {
  const { user, error } = resolvePendingUser(req);

  if (error) {
    if (error !== 'unauthenticated' && req.session) {
      return req.session.destroy(() => res.status(PENDING_STATUS[error]).json({ error }));
    }
    return res.status(PENDING_STATUS[error]).json({ error });
  }

  req.pendingUser = user;
  return next();
}

/**
 * Привязка TOTP возможна в двух положениях: администратор делает её при
 * первом входе (сессия ещё промежуточная) и обычный пользователь — когда
 * захочет, уже войдя. Поэтому годится любое из состояний.
 */
function requireAuthOrPendingMfa(req, res, next) {
  const full = resolveSessionUser(req);
  if (full.user) {
    req.user = full.user;
    req.enrollingUser = full.user;
    return next();
  }

  const pending = resolvePendingUser(req);
  if (pending.user) {
    req.pendingUser = pending.user;
    req.enrollingUser = pending.user;
    return next();
  }

  const error = pending.error === 'unauthenticated' ? full.error : pending.error;
  return res.status(PENDING_STATUS[error] || 401).json({ error });
}

module.exports = {
  requireAuth,
  requireAdmin,
  requirePendingMfa,
  requireAuthOrPendingMfa,
  resolveSessionUser,
  resolvePendingUser,
  MFA_CHALLENGE_TTL_MS,
};
