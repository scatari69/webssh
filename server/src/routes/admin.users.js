'use strict';

const express = require('express');

const password = require('../auth/password');
const audit = require('../services/audit');
const totpService = require('../services/totp');
const users = require('../services/users');

const router = express.Router();

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
const ROLES = new Set(['admin', 'user']);

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Приложение остаётся управляемым, только пока есть хотя бы один активный
 * администратор. Проверка стоит перед деактивацией и перед понижением роли:
 * иначе единственный админ способен запереть себя снаружи, и починить это
 * можно будет только правкой БД.
 */
function wouldRemoveLastAdmin(user) {
  return user.role === 'admin' && user.is_active && users.countActiveAdmins() <= 1;
}

router.get('/users', (_req, res) => {
  res.json({ users: users.list().map(users.toPublic) });
});

/**
 * POST /api/admin/users
 *
 * Пароль можно задать явно либо не передавать — тогда он генерируется.
 * Сгенерированный пароль возвращается в ответе ровно один раз: в БД лежит
 * только bcrypt-хеш, и восстановить его потом неоткуда.
 */
router.post('/users', async (req, res, next) => {
  try {
    const { username, role, password: rawPassword } = req.body || {};

    if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
      return res.status(400).json({ error: 'username_invalid' });
    }
    if (!ROLES.has(role)) {
      return res.status(400).json({ error: 'role_invalid' });
    }
    if (users.usernameTaken(username)) {
      return res.status(409).json({ error: 'username_taken' });
    }

    const generated = rawPassword === undefined || rawPassword === null || rawPassword === '';
    const effectivePassword = generated ? password.generateTemporary() : rawPassword;

    if (!generated) {
      const problem = password.validate(effectivePassword);
      if (problem) return res.status(400).json({ error: problem });
    }

    const created = users.create({
      username,
      passwordHash: await password.hash(effectivePassword),
      role,
      createdBy: req.user.id,
    });

    audit.record({
      req,
      action: 'user.created',
      targetType: 'user',
      targetId: created.id,
      detail: { username, role, password_generated: generated },
    });

    return res.status(201).json({
      user: users.toPublic(created),
      // Показывается один раз и только при генерации.
      temporary_password: generated ? effectivePassword : undefined,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /api/admin/users/:id
 *
 * Деактивация, а не удаление строки. Записи в audit_log ссылаются на
 * пользователя, и физическое удаление либо оборвало бы эти ссылки, либо
 * потребовало бы чистки журнала — а журнал здесь единственный способ
 * связать действие на общем SSH-хосте с конкретным человеком.
 * Побочный эффект: имя остаётся занятым навсегда.
 */
router.delete('/users/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id_invalid' });

  const user = users.findById(id);
  if (!user) return res.status(404).json({ error: 'not_found' });

  if (!user.is_active) {
    return res.json({ user: users.toPublic(user), deactivated: true, already: true });
  }
  if (wouldRemoveLastAdmin(user)) {
    return res.status(409).json({ error: 'last_admin' });
  }

  const updated = users.setActive(id, false);

  audit.record({
    req,
    action: 'user.deactivated',
    targetType: 'user',
    targetId: id,
    detail: { username: user.username, role: user.role },
  });

  return res.json({ user: users.toPublic(updated), deactivated: true });
});

/**
 * PATCH /api/admin/users/:id — включение и отключение учётной записи.
 * Парная операция к DELETE: раз удаления нет, должен быть путь обратно.
 */
router.patch('/users/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id_invalid' });

  const { is_active: isActive } = req.body || {};
  if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'is_active_invalid' });

  const user = users.findById(id);
  if (!user) return res.status(404).json({ error: 'not_found' });

  if (!isActive && user.is_active && wouldRemoveLastAdmin(user)) {
    return res.status(409).json({ error: 'last_admin' });
  }

  const updated = users.setActive(id, isActive);

  audit.record({
    req,
    action: isActive ? 'user.activated' : 'user.deactivated',
    targetType: 'user',
    targetId: id,
    detail: { username: user.username },
  });

  return res.json({ user: users.toPublic(updated) });
});

/**
 * PATCH /api/admin/users/:id/password — сброс пароля администратором.
 * Самостоятельной смены пароля в приложении нет по договорённости.
 */
router.patch('/users/:id/password', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id_invalid' });

    const user = users.findById(id);
    if (!user) return res.status(404).json({ error: 'not_found' });

    const { password: rawPassword } = req.body || {};
    const generated = rawPassword === undefined || rawPassword === null || rawPassword === '';
    const effectivePassword = generated ? password.generateTemporary() : rawPassword;

    if (!generated) {
      const problem = password.validate(effectivePassword);
      if (problem) return res.status(400).json({ error: problem });
    }

    const updated = users.setPassword(id, await password.hash(effectivePassword));

    audit.record({
      req,
      action: 'user.password_reset',
      targetType: 'user',
      targetId: id,
      detail: { username: user.username, password_generated: generated },
    });

    // Сессии пользователя, открытые до этого момента, становятся
    // недействительными: их отсекает проверка password_changed_at в rbac.
    return res.json({
      user: users.toPublic(updated),
      temporary_password: generated ? effectivePassword : undefined,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /api/admin/users/:id/totp — сброс двухфакторки администратором.
 *
 * Без этого потеря телефона вместе с кодами восстановления означала бы
 * безвозвратную потерю доступа, чинимую только правкой БД. Для роли, где
 * TOTP обязателен, следующий вход начнётся с новой привязки.
 */
router.delete('/users/:id/totp', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'id_invalid' });

  const user = users.findById(id);
  if (!user) return res.status(404).json({ error: 'not_found' });

  totpService.reset(id);

  audit.record({
    req,
    action: 'totp.reset_by_admin',
    targetType: 'user',
    targetId: id,
    detail: { username: user.username, was_enabled: Boolean(user.totp_enabled) },
  });

  return res.json({ user: users.toPublic(users.findById(id)) });
});

module.exports = router;
