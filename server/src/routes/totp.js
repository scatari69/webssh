'use strict';

const express = require('express');

const { requireAuth, requireAuthOrPendingMfa, requirePendingMfa } = require('../auth/rbac');
const { establishSession } = require('../auth/session');
const audit = require('../services/audit');
const totpService = require('../services/totp');
const users = require('../services/users');

const router = express.Router();

/**
 * POST /api/totp/enroll — начало привязки.
 *
 * Доступно в двух положениях: администратору, который обязан привязать
 * TOTP при первом входе (сессия ещё промежуточная), и обычному
 * пользователю, решившему включить двухфакторку добровольно.
 *
 * Секрет показывается один раз здесь; в базе он лежит зашифрованным и
 * обратно через API не отдаётся.
 */
router.post('/enroll', requireAuthOrPendingMfa, (req, res) => {
  const user = req.enrollingUser;

  if (user.totp_enabled) {
    return res.status(409).json({ error: 'totp_already_enabled' });
  }

  const { secret, uri } = totpService.startEnrollment(user);

  audit.record({
    req,
    action: 'totp.enrollment_started',
    userId: user.id,
    actorUsername: user.username,
    targetType: 'user',
    targetId: user.id,
  });

  return res.json({ secret, otpauth_uri: uri });
});

/**
 * POST /api/totp/confirm — подтверждение привязки кодом из приложения.
 *
 * Если вход был на промежуточной стадии, здесь он и завершается: отдельно
 * вызывать /verify не нужно, код только что предъявлен.
 *
 * Коды восстановления возвращаются единственный раз — в базе только хеши.
 */
router.post('/confirm', requireAuthOrPendingMfa, async (req, res, next) => {
  try {
    const user = req.enrollingUser;
    const { code } = req.body || {};

    const result = totpService.confirmEnrollment(user, code);

    if (!result.ok) {
      audit.record({
        req,
        action: 'totp.enrollment_confirmed',
        outcome: 'failure',
        userId: user.id,
        actorUsername: user.username,
        detail: { reason: result.error },
      });
      const status = result.error === 'totp_already_enabled' ? 409 : 400;
      return res.status(status).json({ error: result.error });
    }

    const wasPending = Boolean(req.pendingUser);
    if (wasPending) {
      await establishSession(req, user);
      users.recordLoginSuccess(user.id);
    }

    audit.record({
      req,
      action: 'totp.enrollment_confirmed',
      userId: user.id,
      actorUsername: user.username,
      targetType: 'user',
      targetId: user.id,
      detail: { completed_login: wasPending },
    });

    if (wasPending) {
      audit.record({
        req,
        action: 'auth.login',
        outcome: 'success',
        userId: user.id,
        actorUsername: user.username,
        detail: { second_factor: 'totp_enrollment' },
      });
    }

    return res.json({
      user: users.toPublic(users.findById(user.id)),
      recovery_codes: result.recoveryCodes,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/totp/verify — второй фактор при входе.
 * Принимает и код из приложения, и код восстановления.
 */
router.post('/verify', requirePendingMfa, async (req, res, next) => {
  try {
    const user = req.pendingUser;
    const { code } = req.body || {};

    if (!user.totp_enabled) {
      // Привязки нет — значит, шаг сейчас другой.
      return res.status(409).json({ error: 'totp_not_enrolled' });
    }

    const result = totpService.verifyChallenge(user, code);

    if (!result.ok) {
      // Неудача второго фактора считается неудачей входа: она наполняет тот
      // же счётчик и приводит к той же блокировке учётной записи.
      const { lockedUntil } = users.recordLoginFailure(user.id);

      audit.record({
        req,
        action: 'auth.login',
        outcome: 'failure',
        userId: user.id,
        actorUsername: user.username,
        detail: { reason: result.error, stage: 'second_factor', locked: Boolean(lockedUntil) },
      });

      return res.status(401).json({ error: result.error });
    }

    await establishSession(req, user);
    users.recordLoginSuccess(user.id);

    audit.record({
      req,
      action: 'auth.login',
      outcome: 'success',
      userId: user.id,
      actorUsername: user.username,
      detail: { second_factor: result.method },
    });

    return res.json({
      user: users.toPublic(users.findById(user.id)),
      // Когда коды заканчиваются, человека стоит предупредить заранее.
      recovery_codes_remaining: result.recoveryRemaining,
      used_recovery_code: result.method === 'recovery',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/totp/recovery-codes — перевыпуск кодов восстановления.
 * Требует свежий код из приложения: сессии мало, иначе перехваченная
 * сессия позволяла бы выпустить себе новый комплект.
 */
router.post('/recovery-codes', requireAuth, (req, res) => {
  const user = users.findById(req.user.id);
  const { code } = req.body || {};

  if (!user.totp_enabled) return res.status(409).json({ error: 'totp_not_enabled' });

  const check = totpService.verifyChallenge(user, code);
  if (!check.ok) return res.status(401).json({ error: check.error });

  const codes = totpService.replaceRecoveryCodes(user.id);

  audit.record({ req, action: 'totp.recovery_codes_regenerated', targetType: 'user', targetId: user.id });

  return res.json({ recovery_codes: codes });
});

/**
 * DELETE /api/totp — отключение двухфакторки самим пользователем.
 * Администратору отказано, пока TOTP_REQUIRED_FOR_ADMIN включён.
 */
router.delete('/', requireAuth, (req, res) => {
  const user = users.findById(req.user.id);
  const { code } = req.body || {};

  if (!user.totp_enabled) return res.status(409).json({ error: 'totp_not_enabled' });
  if (totpService.isRequiredFor(user)) return res.status(409).json({ error: 'totp_required_for_role' });

  const check = totpService.verifyChallenge(user, code);
  if (!check.ok) return res.status(401).json({ error: check.error });

  totpService.reset(user.id);

  audit.record({ req, action: 'totp.disabled', targetType: 'user', targetId: user.id });

  return res.json({ user: users.toPublic(users.findById(user.id)) });
});

module.exports = router;
