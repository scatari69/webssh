'use strict';

const crypto = require('node:crypto');

const bcrypt = require('bcrypt');

const COST = 12;
const MIN_LENGTH = 12;

/**
 * bcrypt использует только первые 72 байта входа и молча отбрасывает
 * остаток. Длинный пароль тогда эквивалентен своему обрезку — поэтому
 * такие пароли отклоняются явно, а не принимаются с иллюзией стойкости.
 */
const MAX_BYTES = 72;

/**
 * Хеш заведомо недостижимого пароля. Нужен, чтобы вход с несуществующим
 * логином занимал столько же времени, сколько вход с существующим: иначе
 * разница во времени ответа позволяет перебрать список имён.
 */
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), COST);

function hash(password) {
  return bcrypt.hash(password, COST);
}

/**
 * Асинхронно намеренно: bcrypt с cost 12 считается ~250 мс, и синхронный
 * вариант заблокировал бы event loop — вместе со всеми открытыми
 * терминальными сессиями.
 */
function verify(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

/** Сжечь то же время, что и настоящая проверка, когда пользователь не найден. */
function verifyDummy(password) {
  return bcrypt.compare(password, DUMMY_HASH);
}

/**
 * @returns {string|null} код ошибки либо null, если пароль приемлем
 */
function validate(password) {
  if (typeof password !== 'string' || password.length === 0) return 'password_required';
  if (password.length < MIN_LENGTH) return 'password_too_short';
  if (Buffer.byteLength(password, 'utf8') > MAX_BYTES) return 'password_too_long';
  return null;
}

/** Временный пароль для новой учётной записи: 24 символа base64url. */
function generateTemporary() {
  return crypto.randomBytes(18).toString('base64url');
}

module.exports = { hash, verify, verifyDummy, validate, generateTemporary, COST, MIN_LENGTH, MAX_BYTES };
