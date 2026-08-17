'use strict';

const express = require('express');

const router = express.Router();

/**
 * Liveness-проба для docker healthcheck. Эндпоинт доступен без
 * аутентификации и поэтому не отдаёт ничего, кроме факта «процесс жив»:
 * версия, состояние БД и доступность SSH-хоста — в /api/admin/status,
 * под аутентификацией.
 */
router.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

module.exports = router;
