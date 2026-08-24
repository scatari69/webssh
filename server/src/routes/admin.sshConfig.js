'use strict';

const express = require('express');

const audit = require('../services/audit');
const sshConfig = require('../ssh/configStore');
const { testConnection } = require('../ssh/probe');

const router = express.Router();

/** Коды ошибок валидации → 400. Всё остальное считаем внутренней ошибкой. */
const VALIDATION_ERRORS = new Set([
  'host_invalid',
  'port_invalid',
  'ssh_username_invalid',
  'private_key_invalid',
  'private_key_type_unsupported',
  'private_key_missing',
  'passphrase_required',
  'passphrase_invalid',
]);

/**
 * GET /api/admin/ssh-config
 *
 * Приватный ключ и passphrase не отдаются никогда и никому, включая
 * администратора: показывать их незачем — форма редактирования работает
 * по принципу «прислать новое или не трогать». Наружу уходит отпечаток
 * публичной части, тип ключа и признаки наличия.
 */
router.get('/ssh-config', (_req, res) => {
  res.json({ ssh_config: sshConfig.getPublic() });
});

/**
 * PUT /api/admin/ssh-config
 *
 * Тело: host, port, ssh_username и, опционально, private_key / passphrase.
 * Отсутствующее поле ключа означает «не менять», passphrase: null — «убрать».
 */
router.put('/ssh-config', (req, res, next) => {
  try {
    const body = req.body || {};

    const payload = {
      host: typeof body.host === 'string' ? body.host.trim() : body.host,
      port: body.port === undefined ? 22 : Number(body.port),
      ssh_username: typeof body.ssh_username === 'string' ? body.ssh_username.trim() : body.ssh_username,
    };

    if (Object.prototype.hasOwnProperty.call(body, 'private_key')) {
      payload.private_key = body.private_key;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'passphrase')) {
      payload.passphrase = body.passphrase;
    }

    const result = sshConfig.update(payload, req.user.id);

    if (!result.ok) {
      audit.record({
        req,
        action: 'ssh_config.updated',
        outcome: 'failure',
        targetType: 'ssh_config',
        targetId: 1,
        detail: { reason: result.error },
      });
      const status = VALIDATION_ERRORS.has(result.error) ? 400 : 500;
      return res.status(status).json({ error: result.error });
    }

    // В detail попадают только неcекретные признаки: что именно менялось и
    // новый отпечаток ключа. Сам ключ и passphrase вычищаются audit.redact
    // даже при ошибке в вызывающем коде.
    audit.record({
      req,
      action: result.changed.private_key ? 'ssh_config.key_replaced' : 'ssh_config.updated',
      targetType: 'ssh_config',
      targetId: 1,
      detail: {
        changed: result.changed,
        host: result.config.host,
        port: result.config.port,
        ssh_username: result.config.ssh_username,
        private_key_fingerprint: result.config.private_key_fingerprint,
        private_key_type: result.config.private_key_type,
        has_passphrase: result.config.has_passphrase,
      },
    });

    return res.json({ ssh_config: result.config });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/admin/ssh-config/test
 *
 * Пробует подключиться к хосту тем же кодом и тем же ключом, которым пойдёт
 * терминал. Нужна потому, что проверка «из консоли сервера» ничего не
 * доказывает: у приложения своя сетевая область и свой ключ.
 */
router.post('/ssh-config/test', async (req, res, next) => {
  try {
    const result = await testConnection();

    audit.record({
      req,
      action: 'ssh_config.tested',
      outcome: result.ok ? 'success' : 'failure',
      targetType: 'ssh_config',
      targetId: 1,
      detail: result.ok
        ? { fingerprint: result.fingerprint, host_key_learned: result.learned }
        : { reason: result.error, hint: result.hint || null },
    });

    // Неудачная проба — это исправная работа эндпоинта, а не ошибка
    // запроса: код 200 с ok:false, чтобы клиент разбирал причину, а не
    // ловил исключение.
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
