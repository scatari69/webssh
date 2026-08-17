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
  payload_too_large: 'Слишком большой запрос.',
  csrf_token_invalid: 'Сессия устарела. Обновите страницу и повторите действие.',

  /* --------------------------------------------------------- админка */

  not_found: 'Запись не найдена — возможно, список устарел. Обновите страницу.',
  id_invalid: 'Некорректный идентификатор записи.',
  username_invalid: 'Логин: 3–32 символа, латиница, цифры, точка, дефис, подчёркивание.',
  username_taken: 'Такой логин уже занят. Имена не переиспользуются даже после отключения учётной записи.',
  role_invalid: 'Выберите роль.',
  is_active_invalid: 'Некорректное значение состояния.',
  password_required: 'Задайте пароль или включите генерацию.',
  password_too_short: 'Пароль короче 12 символов.',
  // bcrypt читает только первые 72 байта, поэтому длинный пароль
  // отвергается явно, а не принимается с иллюзией стойкости.
  password_too_long: 'Пароль длиннее 72 байт — bcrypt отбросил бы остаток.',
  last_admin: 'Это единственный активный администратор. Сначала назначьте другого.',

  host_invalid: 'Некорректный адрес хоста.',
  port_invalid: 'Порт должен быть числом от 1 до 65535.',
  ssh_username_invalid: 'Некорректное имя системного пользователя.',
  private_key_invalid:
    'Не удалось разобрать ключ. Подходит формат OpenSSH (BEGIN OPENSSH PRIVATE KEY) ' +
    'и классический PEM (BEGIN RSA PRIVATE KEY); PKCS#8 (BEGIN PRIVATE KEY) не поддерживается.',
  private_key_type_unsupported: 'Тип ключа не поддерживается: нужен RSA, ed25519 или ecdsa.',
  private_key_missing: 'Файл сохранённого ключа не найден — загрузите ключ заново.',
  passphrase_required: 'Ключ зашифрован — укажите passphrase.',
  passphrase_invalid: 'Passphrase не подходит к этому ключу.',
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
