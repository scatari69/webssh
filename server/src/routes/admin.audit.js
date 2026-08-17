'use strict';

const express = require('express');

const audit = require('../services/audit');

const router = express.Router();

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Значение из строки запроса приходит от клиента и может быть чем угодно:
 * пустой строкой, массивом (?limit=1&limit=2), «1e9». Всё, что не целое
 * число в границах, заменяется значением по умолчанию — отвечать ошибкой
 * на кривой параметр листалки незачем.
 */
function clampInt(raw, fallback, min, max) {
  const value = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * GET /api/admin/audit?limit=100&offset=0
 *
 * Журнал вычищается от секретов на записи (см. services/audit.redact), а не
 * здесь: страховка должна стоять до попадания значения в БД, иначе секрет
 * уже лежит на диске и утечёт при любом другом способе чтения.
 *
 * Просмотр журнала сам в журнал не пишется: страница обновляет таблицу по
 * кнопке и после каждого действия, и такие записи вытеснили бы из
 * последней сотни всё остальное.
 */
router.get('/audit', (req, res) => {
  const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  res.json({
    entries: audit.list({ limit, offset }),
    limit,
    offset,
    // Чтобы страница могла честно написать «последние 100 из 4213», а не
    // делать вид, что записей ровно столько, сколько показано.
    total: audit.count(),
  });
});

module.exports = router;
