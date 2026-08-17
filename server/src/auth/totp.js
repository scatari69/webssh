'use strict';

const crypto = require('node:crypto');

const { generateSecret, generateSync, generateURI, verifySync } = require('otplib');

const config = require('../config');

/**
 * Обёртка над otplib. Вынесена отдельно, чтобы параметры (допуск дрейфа,
 * формат кода) задавались в одном месте, и чтобы не расползалась пара
 * ловушек этой библиотеки: epoch задаётся в СЕКУНДАХ, а допуск называется
 * epochTolerance и тоже в секундах — не «window» в шагах, как во многих
 * других реализациях.
 */

/** ±30 секунд, то есть один шаг в каждую сторону. */
const EPOCH_TOLERANCE_SECONDS = 30;

const TOKEN_PATTERN = /^\d{6}$/;

/**
 * Алфавит кодов восстановления без символов, которые путаются при чтении с
 * бумаги: I/1, O/0.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_LENGTH = 16;
const RECOVERY_GROUP = 4;
const RECOVERY_COUNT = 10;

function createSecret() {
  return generateSecret();
}

/** URI для QR-кода в приложении-аутентификаторе. */
function buildUri(secret, username) {
  return generateURI({ issuer: config.totp.issuer, label: username, secret });
}

function isWellFormedToken(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

/**
 * @returns {{valid: true, timeStep: number, delta: number}|{valid: false}}
 * timeStep нужен вызывающему коду, чтобы отклонить повторное предъявление
 * того же кода внутри его окна действия.
 */
function verifyToken(secret, token) {
  if (!isWellFormedToken(token)) return { valid: false };

  const result = verifySync({ secret, token, epochTolerance: EPOCH_TOLERANCE_SECONDS });
  if (!result.valid) return { valid: false };

  return { valid: true, timeStep: result.timeStep, delta: result.delta };
}

/**
 * Код для заданного момента. Нужен тестам и диагностике; в рабочем потоке
 * коды генерирует приложение-аутентификатор на стороне пользователя.
 * @param {number} [epochSeconds] секунды, не миллисекунды
 */
function generateToken(secret, epochSeconds) {
  return epochSeconds === undefined ? generateSync({ secret }) : generateSync({ secret, epoch: epochSeconds });
}

/**
 * Коды восстановления: 16 символов из 32-буквенного алфавита — 80 бит
 * энтропии. Форматируются группами по четыре, чтобы их можно было
 * переписать без ошибок.
 */
function generateRecoveryCodes(count = RECOVERY_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    let raw = '';
    for (let c = 0; c < RECOVERY_LENGTH; c += 1) {
      raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.push(raw.match(new RegExp(`.{1,${RECOVERY_GROUP}}`, 'g')).join('-'));
  }
  return codes;
}

/** Приводит введённый код к каноническому виду: регистр и дефисы не важны. */
function normalizeRecoveryCode(input) {
  if (typeof input !== 'string') return '';
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Коды восстановления хешируются SHA-256, а не bcrypt.
 *
 * bcrypt намеренно медленный, потому что защищает пароли, выбранные
 * человеком, — с их низкой энтропией перебор реалистичен. Здесь секрет
 * случайный и содержит 80 бит: перебор невозможен независимо от скорости
 * хеша. Зато медленный хеш пришлось бы прогонять против каждого
 * неиспользованного кода пользователя, превращая проверку в рычаг
 * исчерпания процессора. Быстрый хеш позволяет искать код одним
 * индексированным запросом.
 */
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code), 'utf8').digest('hex');
}

module.exports = {
  createSecret,
  buildUri,
  verifyToken,
  generateToken,
  isWellFormedToken,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
  RECOVERY_COUNT,
  EPOCH_TOLERANCE_SECONDS,
};
