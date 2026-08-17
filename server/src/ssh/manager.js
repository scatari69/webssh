'use strict';

const config = require('../config');
const { CLOSE } = require('../ws/protocol');

/**
 * Реестр живых терминальных сессий.
 *
 * Хранится в памяти процесса намеренно: сессия неразрывно связана с
 * открытым сокетом и переживать перезапуск не может, а строка в БД после
 * падения осталась бы висеть и требовать чистки. История же и так есть в
 * audit_log.
 */

const sessions = new Map();

const IDLE_SWEEP_INTERVAL_MS = 30_000;

function countForUser(userId) {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.user.id === userId) count += 1;
  }
  return count;
}

/**
 * Лимиты защищают общий хост: каждая сессия — это процесс на нём, и без
 * потолка одна вкладка в цикле способна исчерпать его ресурсы.
 *
 * @returns {{ok: true}|{ok: false, error: string, code: number}}
 */
function canOpen(userId) {
  if (sessions.size >= config.limits.maxSessionsTotal) {
    return { ok: false, error: 'session_limit_total', code: CLOSE.SESSION_LIMIT };
  }
  if (countForUser(userId) >= config.limits.maxSessionsPerUser) {
    return { ok: false, error: 'session_limit_user', code: CLOSE.SESSION_LIMIT };
  }
  return { ok: true };
}

function register(session) {
  sessions.set(session.id, session);
  session.onClosed = () => sessions.delete(session.id);
}

function list() {
  return [...sessions.values()].map((session) => ({
    id: session.id,
    user_id: session.user.id,
    username: session.user.username,
    opened_at: new Date(session.startedAt).toISOString(),
    last_activity_at: new Date(session.lastActivityAt).toISOString(),
    bytes_in: session.bytesIn,
    bytes_out: session.bytesOut,
    ip: session.ip,
  }));
}

/**
 * Обрыв всех сессий пользователя. Нужен, чтобы деактивация учётной записи
 * и сброс пароля действовали на уже открытый шелл: иначе отключённый
 * пользователь продолжал бы работать на хосте до тех пор, пока сам не
 * закроет вкладку.
 */
function closeAllForUser(userId, reason = 'session_revoked') {
  let closed = 0;
  for (const session of [...sessions.values()]) {
    if (session.user.id !== userId) continue;
    session.terminate(CLOSE.FORBIDDEN, reason, 'Сессия завершена администратором.');
    closed += 1;
  }
  return closed;
}

function closeAll(reason = 'server_shutdown') {
  for (const session of [...sessions.values()]) {
    session.terminate(CLOSE.SERVER_SHUTDOWN, reason, 'Сервер останавливается.');
  }
}

function sweepIdle(now = Date.now()) {
  let closed = 0;
  for (const session of [...sessions.values()]) {
    if (!session.isIdle(now)) continue;
    session.terminate(CLOSE.IDLE_TIMEOUT, 'idle_timeout', 'Сессия закрыта из-за простоя.');
    closed += 1;
  }
  return closed;
}

let sweeper = null;

function startIdleSweeper() {
  if (sweeper) return sweeper;
  sweeper = setInterval(sweepIdle, IDLE_SWEEP_INTERVAL_MS);
  // Таймер не должен удерживать процесс от завершения.
  sweeper.unref();
  return sweeper;
}

function stopIdleSweeper() {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}

module.exports = {
  canOpen,
  register,
  list,
  countForUser,
  closeAllForUser,
  closeAll,
  sweepIdle,
  startIdleSweeper,
  stopIdleSweeper,
  get size() {
    return sessions.size;
  },
};
