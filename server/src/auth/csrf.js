'use strict';

const crypto = require('node:crypto');

/**
 * Защита от подделки межсайтовых запросов.
 *
 * До сих пор её роль исполняли два косвенных барьера: cookie сессии с
 * `sameSite=lax` (браузер не отправляет её при межсайтовом POST) и
 * требование `Content-Type: application/json`, который межсайтовая HTML-форма
 * выставить не может. Оба реальны, но оба — свойства чужого кода: политика
 * lax уже размывалась в спорах о совместимости, а разбор тела мог бы завтра
 * начать принимать form-urlencoded ради какой-нибудь интеграции. Синхронизи-
 * рующий токен не зависит ни от того, ни от другого.
 *
 * Схема простая: при выдаче сессии в неё кладётся случайный токен, он же
 * возвращается клиенту в теле ответа, и каждый мутирующий запрос обязан
 * прислать его заголовком. Прочитать тело ответа с чужого origin нельзя
 * (CORS-заголовков приложение не выдаёт), а выставить произвольный заголовок
 * в межсайтовом запросе — тем более.
 */

const HEADER = 'x-csrf-token';

/** Методы, которые по определению ничего не меняют. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Вход исключён намеренно. Сессии в этот момент ещё нет, а значит, неоткуда
 * взяться и токену: страница входа не может получить его, не создав сессию
 * каждому анониму, который просто открыл форму. Сам по себе вход состояния
 * учётной записи не меняет, а от навязывания чужой сессии защищает
 * `sameSite`, перевыпуск идентификатора при входе и лимит попыток.
 */
const EXEMPT_PATHS = new Set(['/login']);

/** Новый токен для текущей сессии. Вызывается сразу после её перевыпуска. */
function issue(req) {
  const token = crypto.randomBytes(32).toString('base64url');
  req.session.csrfToken = token;
  return token;
}

function tokenFor(req) {
  return (req.session && req.session.csrfToken) || null;
}

function matches(expected, provided) {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  // Сравнение постоянного времени: побайтовое сравнение с ранним выходом
  // позволяет подбирать токен по времени ответа.
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
}

function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT_PATHS.has(req.path)) return next();

  const expected = tokenFor(req);

  // Токена в сессии нет — значит, нет и самой сессии, а с ней и состояния,
  // которое можно было бы подделать. Такой запрос всё равно упрётся в
  // requireAuth.
  if (!expected) return next();

  if (!matches(expected, req.get(HEADER))) {
    return res.status(403).json({ error: 'csrf_token_invalid' });
  }

  return next();
}

module.exports = { requireCsrf, issue, tokenFor, HEADER, EXEMPT_PATHS };
