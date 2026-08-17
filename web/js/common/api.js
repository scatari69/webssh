/**
 * Обёртка над fetch для JSON-API. Аутентификация — cookie сессии, её
 * отправляет сам браузер, поэтому здесь только единообразный разбор
 * ответов и понятные тексты ошибок.
 */

import { has, t } from './i18n.js';

/**
 * Текст ошибки строится по коду, а не по полю message из ответа: сервер
 * не знает, на каком языке смотрит человек. Серверная строка остаётся
 * запасным вариантом для кодов, которых ещё нет в словаре.
 */
export function describeError(code, body) {
  if (code === 'account_locked' && body && body.retry_after_seconds) {
    return t('err.account_locked_retry', { minutes: Math.ceil(body.retry_after_seconds / 60) });
  }
  if (code && has(`err.${code}`)) return t(`err.${code}`);
  if (body && typeof body.message === 'string' && body.message) return body.message;
  return t('err.unknown');
}

export class ApiError extends Error {
  constructor(status, body) {
    super(describeError(body && body.error, body));
    this.status = status;
    this.code = (body && body.error) || 'unknown';
    this.body = body || {};
  }
}

/*
 * CSRF-токен выдаётся сервером вместе с сессией и приходит в теле ответа —
 * при входе и в /api/me. Хранится в памяти вкладки, а не в cookie или
 * localStorage: то и другое пережило бы вкладку и стало бы доступно
 * стороннему коду, а смысл токена именно в том, что достать его извне
 * нельзя. Захват и отправка автоматические, чтобы ни один вызов не забыли.
 */
let csrfToken = null;

export function setCsrfToken(token) {
  if (typeof token === 'string' && token) csrfToken = token;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && MUTATING.has(method)) headers['X-CSRF-Token'] = csrfToken;

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  // Вход и подтверждение второго фактора перевыпускают сессию, а с ней и
  // токен. Забирать новый нужно из того же ответа — иначе следующий
  // мутирующий запрос уйдёт со старым.
  if (payload && payload.csrf_token) setCsrfToken(payload.csrf_token);

  if (!response.ok) throw new ApiError(response.status, payload);
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body === undefined ? {} : body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path, body) => request('DELETE', path, body),
};
