'use strict';

const crypto = require('node:crypto');

const { getDb } = require('../db');

/**
 * Проверка ключа хоста.
 *
 * Без неё ssh2 принимает любой предъявленный сервером ключ, то есть
 * соединение открыто для подмены посредником — и вся защита сводится к
 * тому, что канал «наверное» ведёт куда надо. Поэтому проверка включена
 * всегда, а политика лишь определяет, как поступать с ещё не известным
 * ключом.
 *
 *   tofu     — первый увиденный ключ запоминается, дальше сверяется строго
 *   pinned   — принимается только уже запомненный ключ
 *   insecure — приниматься будет что угодно (только для отладки)
 */

function fingerprint(keyBuffer) {
  const digest = crypto.createHash('sha256').update(keyBuffer).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

function rememberHostKey(keyBuffer) {
  getDb()
    .prepare('UPDATE ssh_config SET known_host_key = ?, known_host_fingerprint = ? WHERE id = 1')
    .run(keyBuffer.toString('base64'), fingerprint(keyBuffer));
}

/**
 * Возвращает функцию для опции hostVerifier клиента ssh2.
 *
 * ssh2 передаёт сюда открытый ключ сервера как Buffer (пока не задан
 * hostHash) и трактует любое значение, кроме undefined, как синхронный
 * вердикт. Наша БД синхронная, поэтому так и отвечаем.
 *
 * @param {object} cfg строка ssh_config
 * @param {(info: {presented: string, expected: string|null}) => void} onMismatch
 * @param {(info: {fingerprint: string}) => void} [onLearn]
 */
function createHostVerifier(cfg, { onMismatch, onLearn } = {}) {
  return (key) => {
    const presentedKey = Buffer.isBuffer(key) ? key : Buffer.from(key);
    const presented = fingerprint(presentedKey);

    if (cfg.host_key_policy === 'insecure') return true;

    if (!cfg.known_host_key) {
      if (cfg.host_key_policy === 'pinned') {
        // Закреплять нечего: ключ ещё не выучен, а политика запрещает
        // доверять неизвестному.
        if (onMismatch) onMismatch({ presented, expected: null });
        return false;
      }

      rememberHostKey(presentedKey);
      if (onLearn) onLearn({ fingerprint: presented });
      return true;
    }

    // Сравнение по самому ключу, а не по отпечатку: отпечаток — производная,
    // и сверять стоит первоисточник.
    const expectedKey = Buffer.from(cfg.known_host_key, 'base64');
    const matches =
      expectedKey.length === presentedKey.length && crypto.timingSafeEqual(expectedKey, presentedKey);

    if (!matches && onMismatch) {
      onMismatch({ presented, expected: cfg.known_host_fingerprint || fingerprint(expectedKey) });
    }

    return matches;
  };
}

module.exports = { createHostVerifier, fingerprint, rememberHostKey };
