'use strict';

const express = require('express');

const password = require('../auth/password');
const { requireAuth } = require('../auth/rbac');
const { sessionCookieName } = require('../auth/session');
const audit = require('../services/audit');
const users = require('../services/users');

const router = express.Router();

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * POST /api/login
 *
 * Ответ на неверный пароль и на несуществующего пользователя одинаков —
 * `invalid_credentials` — и занимает одинаковое время (см. verifyDummy),
 * чтобы по ответу нельзя было перебрать список имён.
 */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password: rawPassword } = req.body || {};

    if (typeof username !== 'string' || typeof rawPassword !== 'string' || !username || !rawPassword) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const user = users.findByUsername(username);

    if (!user) {
      await password.verifyDummy(rawPassword);
      audit.record({
        req,
        action: 'auth.login',
        outcome: 'failure',
        userId: null,
        actorUsername: username.slice(0, 64),
        detail: { reason: 'unknown_user' },
      });
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    if (users.isLocked(user)) {
      audit.record({
        req,
        action: 'auth.login',
        outcome: 'failure',
        userId: user.id,
        actorUsername: user.username,
        detail: { reason: 'locked' },
      });
      const retryAfter = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
      return res.status(423).json({ error: 'account_locked', retry_after_seconds: retryAfter });
    }

    if (!user.is_active) {
      audit.record({
        req,
        action: 'auth.login',
        outcome: 'failure',
        userId: user.id,
        actorUsername: user.username,
        detail: { reason: 'disabled' },
      });
      return res.status(403).json({ error: 'account_disabled' });
    }

    const ok = await password.verify(rawPassword, user.password_hash);

    if (!ok) {
      const { failures, lockedUntil } = users.recordLoginFailure(user.id);
      audit.record({
        req,
        action: 'auth.login',
        outcome: 'failure',
        userId: user.id,
        actorUsername: user.username,
        detail: { reason: 'bad_password', failures, locked: Boolean(lockedUntil) },
      });
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    // Новый идентификатор сессии на каждый вход — защита от фиксации:
    // идентификатор, который атакующий мог подсунуть до входа, становится
    // бесполезным.
    await regenerateSession(req);
    req.session.user = { id: user.id, username: user.username, role: user.role };
    req.session.createdAt = Date.now();
    await saveSession(req);

    users.recordLoginSuccess(user.id);
    audit.record({
      req,
      action: 'auth.login',
      outcome: 'success',
      userId: user.id,
      actorUsername: user.username,
    });

    return res.json({ user: users.toPublic(users.findById(user.id)) });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const sessionUser = req.session && req.session.user;

    if (sessionUser) {
      audit.record({
        req,
        action: 'auth.logout',
        userId: sessionUser.id,
        actorUsername: sessionUser.username,
      });
    }

    if (req.session) await destroySession(req);
    res.clearCookie(sessionCookieName(), { path: '/' });

    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: users.toPublic(req.user) });
});

module.exports = router;
