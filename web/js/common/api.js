/**
 * Обёртка над fetch для JSON-API. Аутентификация — cookie сессии, её
 * отправляет сам браузер, поэтому здесь только единообразный разбор
 * ответов и понятные тексты ошибок.
 */

const ERROR_MESSAGES = {
  invalid_credentials: 'Неверный логин или пароль.',
  invalid_request: 'Заполните оба поля.',
  account_disabled: 'Учётная запись отключена. Обратитесь к администратору.',
  account_locked: 'Слишком много неудачных попыток. Учётная запись временно заблокирована.',
  too_many_attempts: 'Слишком много попыток. Повторите позже.',
  unauthenticated: 'Сессия не найдена или истекла.',
  session_expired: 'Сессия истекла, войдите заново.',
  forbidden: 'Недостаточно прав.',
  mfa_challenge_expired: 'Время на подтверждение истекло. Войдите заново.',
  totp_code_invalid: 'Неверный код. Проверьте время на устройстве и попробуйте ещё раз.',
  totp_code_reused: 'Этот код уже использован. Дождитесь следующего.',
  totp_not_enrolled: 'Двухфакторка ещё не привязана.',
  totp_already_enabled: 'Двухфакторка уже привязана.',
  totp_not_started: 'Привязка не начата.',
  invalid_json: 'Некорректный запрос.',
  internal_error: 'Внутренняя ошибка сервера.',
};

export function describeError(code, body) {
  if (code === 'account_locked' && body && body.retry_after_seconds) {
    const minutes = Math.ceil(body.retry_after_seconds / 60);
    return `Учётная запись временно заблокирована. Повторите через ${minutes} мин.`;
  }
  return ERROR_MESSAGES[code] || 'Не удалось выполнить запрос.';
}

export class ApiError extends Error {
  constructor(status, body) {
    super(describeError(body && body.error, body));
    this.status = status;
    this.code = (body && body.error) || 'unknown';
    this.body = body || {};
  }
}

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
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
