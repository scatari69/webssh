'use strict';

const rateLimit = require('express-rate-limit');

const config = require('../config');

/**
 * Заградительный лимит на вход. Стоит перед bcrypt намеренно: проверка
 * пароля с cost 12 занимает ~250 мс процессорного времени, поэтому без
 * этого барьера перебор превращается ещё и в отказ в обслуживании.
 *
 * Считаются только неудачные попытки (skipSuccessfulRequests): иначе
 * человек, несколько раз вошедший и вышедший за 15 минут, запирает сам
 * себя, ничего не подбирая.
 *
 * Ключ — req.ip, который берётся из X-Forwarded-For с учётом
 * `trust proxy = 1`. Доверять более длинной цепочке нельзя: клиент подделал
 * бы адрес и обошёл лимит.
 */
function createLoginRateLimiter() {
  return rateLimit({
    windowMs: config.access.loginRateWindowMs,
    limit: config.access.loginRateMaxAttempts,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const retryAfterSec = Math.ceil(config.access.loginRateWindowMs / 1000);
      res.status(429).json({ error: 'too_many_attempts', retry_after_seconds: retryAfterSec });
    },
  });
}

module.exports = { createLoginRateLimiter };
