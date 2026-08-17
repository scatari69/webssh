'use strict';

/**
 * Протокол терминального WebSocket.
 *
 * Клиент → сервер: JSON-сообщения {type:'data'|'resize'|'ping'}. Для
 * удобства принимаются и «сырые» двоичные кадры — они трактуются как ввод.
 *
 * Сервер → клиент: двоичные кадры — это байты вывода PTY как есть, а
 * текстовые (JSON) — управляющие сообщения.
 *
 * Вывод намеренно НЕ заворачивается в JSON. Поток PTY — это байты, а не
 * текст: SSH отдаёт их произвольными порциями, и граница порции регулярно
 * рассекает многобайтовый символ UTF-8. Преобразование такой порции в
 * строку подменило бы разрезанный символ на U+FFFD, необратимо испортив
 * вывод; вдобавок терминал может выдавать и вовсе не-UTF-8 данные.
 * Двоичный кадр этой проблемы не имеет вовсе.
 */

const config = require('../config');

/** Коды закрытия из частного диапазона 4000–4999. */
const CLOSE = {
  NORMAL: 1000,
  UNAUTHENTICATED: 4401,
  FORBIDDEN: 4403,
  NOT_CONFIGURED: 4404,
  IDLE_TIMEOUT: 4408,
  SESSION_LIMIT: 4409,
  HOST_KEY_MISMATCH: 4410,
  MESSAGE_TOO_LARGE: 4413,
  SSH_ERROR: 4500,
  SERVER_SHUTDOWN: 4503,
};

/** Разумный потолок размеров окна: защита от бессмысленных значений. */
const MAX_DIMENSION = 1000;

/**
 * @returns {{type:'data', data: Buffer}
 *          |{type:'resize', cols:number, rows:number}
 *          |{type:'ping'}
 *          |{type:'error', error:string}}
 */
function parseClientMessage(raw, isBinary) {
  if (isBinary) return { type: 'data', data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw) };

  // Проверка в байтах и до toString: длина строки в символах меньше длины
  // в байтах для всего, что вне ASCII, а лишняя копия мегабайтного кадра в
  // виде строки — ровно тот расход, которого мы избегаем. Настоящий барьер
  // всё равно стоит раньше — maxPayload в ws, — это защита на случай, если
  // кадр придёт другим путём.
  if (raw.length > config.limits.wsMaxMessageBytes) {
    return { type: 'error', error: 'message_too_large' };
  }

  const text = raw.toString('utf8');

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return { type: 'error', error: 'invalid_json' };
  }

  if (!message || typeof message !== 'object') return { type: 'error', error: 'invalid_message' };

  switch (message.type) {
    case 'data': {
      if (typeof message.data !== 'string') return { type: 'error', error: 'invalid_data' };
      return { type: 'data', data: Buffer.from(message.data, 'utf8') };
    }
    case 'resize': {
      const cols = Number(message.cols);
      const rows = Number(message.rows);
      if (
        !Number.isInteger(cols) ||
        !Number.isInteger(rows) ||
        cols < 1 ||
        rows < 1 ||
        cols > MAX_DIMENSION ||
        rows > MAX_DIMENSION
      ) {
        return { type: 'error', error: 'invalid_dimensions' };
      }
      return { type: 'resize', cols, rows };
    }
    case 'ping':
      return { type: 'ping' };
    default:
      return { type: 'error', error: 'unknown_message_type' };
  }
}

function sendJson(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sendData(ws, chunk, callback) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(chunk, { binary: true }, callback);
}

/**
 * Причина в кадре закрытия ограничена 123 байтами — более длинная строка
 * приводит к исключению вместо закрытия.
 */
function closeWith(ws, code, reason = '') {
  if (ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING) return;
  ws.close(code, Buffer.from(String(reason), 'utf8').subarray(0, 120).toString('utf8'));
}

/** Сообщение об ошибке в формате, ожидаемом клиентом, и следом закрытие. */
function failAndClose(ws, code, error, message) {
  sendJson(ws, { type: 'error', error, message });
  closeWith(ws, code, error);
}

module.exports = {
  CLOSE,
  MAX_DIMENSION,
  parseClientMessage,
  sendJson,
  sendData,
  closeWith,
  failAndClose,
};
