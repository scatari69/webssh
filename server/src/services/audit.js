'use strict';

const { getDb } = require('../db');

/**
 * Единственная точка записи в audit_log. Централизована ради вычистки
 * секретов: журнал доступен администраторам и выгружается наружу, поэтому
 * пароль или passphrase, случайно попавшие в detail, — это утечка.
 */

/**
 * Имена, которые выглядят «секретными», но секретов не содержат и в журнале
 * полезны: по отпечатку видно, что ключ действительно сменился.
 */
const NOT_SECRET = new Set(['private_key_fingerprint', 'private_key_type', 'has_private_key', 'has_passphrase']);

const SECRET_NAME = /pass(word|phrase)?|private_key|secret|token|totp|recovery/i;

const REDACTED = '[redacted]';

function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (!NOT_SECRET.has(key) && SECRET_NAME.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

/**
 * @param {object} params
 * @param {import('express').Request} [params.req] источник ip/user-agent/актора
 * @param {string} params.action например 'user.created'
 * @param {'success'|'failure'} [params.outcome]
 * @param {number|null} [params.userId] актор; по умолчанию берётся из req.user
 * @param {string} [params.actorUsername]
 */
function record({
  req = null,
  action,
  outcome = 'success',
  userId,
  actorUsername,
  targetType = null,
  targetId = null,
  terminalSessionId = null,
  detail = null,
  ip,
  userAgent: userAgentOverride,
}) {
  const actor = req && req.user ? req.user : null;
  const resolvedUserId = userId !== undefined ? userId : actor ? actor.id : null;
  const resolvedUsername = actorUsername !== undefined ? actorUsername : actor ? actor.username : null;

  // ip и userAgent можно передать явно: у WebSocket-соединения нет объекта
  // express-запроса, там доступен только сырой IncomingMessage.
  const rawUserAgent =
    userAgentOverride !== undefined ? userAgentOverride : req ? req.get('user-agent') : null;

  // Заголовок приходит от клиента и длину не ограничивает — обрезаем,
  // иначе журнал раздувается на мусорных запросах.
  const userAgent = String(rawUserAgent || '').slice(0, 300) || null;
  const resolvedIp = ip !== undefined ? ip : req ? req.ip || null : null;

  getDb()
    .prepare(
      `INSERT INTO audit_log
         (user_id, actor_username, action, outcome, target_type, target_id,
          terminal_session_id, ip, user_agent, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      resolvedUserId,
      resolvedUsername,
      action,
      outcome,
      targetType,
      targetId === null ? null : String(targetId),
      terminalSessionId,
      resolvedIp,
      userAgent,
      detail === null ? null : JSON.stringify(redact(detail))
    );
}

/**
 * detail лежит в БД строкой. Наружу отдаём разобранным объектом: иначе
 * разбор пришлось бы делать в браузере, вместе с обработкой битой строки.
 * Испорченная запись не должна ронять весь список, поэтому при неудаче
 * возвращаем исходный текст — видеть его полезнее, чем потерять строку.
 */
function parseDetail(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: String(value).slice(0, 500) };
  }
}

function list({ limit = 100, offset = 0 } = {}) {
  return getDb()
    .prepare(
      `SELECT id, user_id, actor_username, action, outcome, target_type, target_id,
              terminal_session_id, ip, user_agent, detail, created_at
         FROM audit_log
        ORDER BY id DESC
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset)
    .map((entry) => ({ ...entry, detail: parseDetail(entry.detail) }));
}

function count() {
  return getDb().prepare('SELECT COUNT(*) AS count FROM audit_log').get().count;
}

module.exports = { record, list, count, redact };
