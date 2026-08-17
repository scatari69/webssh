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
}) {
  const actor = req && req.user ? req.user : null;
  const resolvedUserId = userId !== undefined ? userId : actor ? actor.id : null;
  const resolvedUsername = actorUsername !== undefined ? actorUsername : actor ? actor.username : null;

  // Заголовок приходит от клиента и длину не ограничивает — обрезаем,
  // иначе журнал раздувается на мусорных запросах.
  const userAgent = req ? String(req.get('user-agent') || '').slice(0, 300) || null : null;

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
      req ? req.ip || null : null,
      userAgent,
      detail === null ? null : JSON.stringify(redact(detail))
    );
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
    .all(limit, offset);
}

module.exports = { record, list, redact };
