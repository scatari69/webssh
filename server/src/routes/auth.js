'use strict';

const express = require('express');

const csrf = require('../auth/csrf');
const password = require('../auth/password');
const { requireAuth } = require('../auth/rbac');
const {
  destroy: destroySession,
  establishMfaChallenge,
  establishSession,
  sessionCookieName,
} = require('../auth/session');
const audit = require('../services/audit');
const totpService = require('../services/totp');
const users = require('../services/users');

const router = express.Router();

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

    // Пароль принят. Если нужен второй фактор, полноценная сессия здесь не
    // выдаётся: вход завершится только после /api/totp/verify или, для
    // первой привязки, после /api/totp/confirm.
    if (totpService.isChallengeNeeded(user)) {
      await establishMfaChallenge(req, user);

      audit.record({
        req,
        action: 'auth.mfa_challenge',
        outcome: 'success',
        userId: user.id,
        actorUsername: user.username,
        detail: { enrolled: Boolean(user.totp_enabled) },
      });

      return res.json({
        // Токен для последующих шагов привязки и подтверждения: они уже
        // мутирующие, а сессия — пусть и промежуточная — уже есть.
        csrf_token: csrf.tokenFor(req),
        mfa: {
          required: true,
          // false означает, что привязки ещё нет и следующий шаг —
          // /api/totp/enroll, а не /api/totp/verify.
          enrolled: Boolean(user.totp_enabled),
        },
      });
    }

    await establishSession(req, user);

    users.recordLoginSuccess(user.id);
    audit.record({
      req,
      action: 'auth.login',
      outcome: 'success',
      userId: user.id,
      actorUsername: user.username,
    });

    return res.json({
      user: users.toPublic(users.findById(user.id)),
      csrf_token: csrf.tokenFor(req),
      mfa: { required: false },
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const sessionUser = req.session && (req.session.user || null);

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

/**
 * Помимо самого пользователя отдаёт действующий CSRF-токен: страницы
 * начинают работу с этого запроса, и отдельный эндпоинт за токеном был бы
 * лишним кругом.
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: users.toPublic(req.user),
    csrf_token: csrf.tokenFor(req),
    // Второй фактор человек настраивает на /account, и странице нужно
    // знать не только «включён», но и сколько одноразовых кодов осталось:
    // когда они кончаются, предупредить надо заранее.
    totp: {
      required: totpService.isRequiredFor(req.user),
      recovery_codes_remaining: req.user.totp_enabled
        ? totpService.countRecoveryCodes(req.user.id)
        : 0,
    },
  });
});

module.exports = router;
