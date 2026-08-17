'use strict';

const fs = require('node:fs');
const path = require('node:path');

const express = require('express');

const { resolveSessionUser } = require('../auth/rbac');

const router = express.Router();

/**
 * В репозитории каталог web лежит рядом с server, а в образе — внутри
 * /app. Пробуем оба варианта вместо того, чтобы жёстко зашивать один:
 * иначе приложение работало бы либо в разработке, либо в контейнере.
 */
const WEB_ROOT = [
  process.env.WEB_ROOT,
  path.join(__dirname, '..', '..', '..', 'web'),
  path.join(__dirname, '..', '..', 'web'),
]
  .filter(Boolean)
  .find((candidate) => fs.existsSync(path.join(candidate, 'login.html')));

if (!WEB_ROOT) {
  throw new Error(
    'Не найден каталог со статикой (ожидался web/ рядом с server/ или внутри /app). ' +
      'Укажите путь в переменной WEB_ROOT.'
  );
}

/**
 * HTML-страницы отдаются с проверкой сессии и редиректами, а не кодом 401:
 * человеку в браузере нужна форма входа, а не JSON с ошибкой. Сами
 * страницы секретов не содержат — все данные они получают через API, тоже
 * под проверкой, — но отправлять неаутентифицированного сразу на нужный
 * экран честнее и понятнее.
 */

function sendPage(res, file) {
  // Страницы меняются вместе с образом и должны обновляться сразу после
  // выкатки — кешировать их не нужно.
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(WEB_ROOT, file));
}

router.get('/login', (req, res) => {
  const { user } = resolveSessionUser(req);
  if (user) return res.redirect('/');
  return sendPage(res, 'login.html');
});

router.get('/', (req, res) => {
  const { user } = resolveSessionUser(req);
  if (!user) return res.redirect('/login');
  return sendPage(res, 'terminal.html');
});

router.get('/admin', (req, res) => {
  const { user } = resolveSessionUser(req);
  if (!user) return res.redirect('/login');
  // Обычного пользователя отправляем в терминал: показывать ему страницу,
  // которая всё равно ничего не покажет, незачем.
  if (user.role !== 'admin') return res.redirect('/');
  return sendPage(res, 'admin.html');
});

module.exports = { pagesRouter: router, WEB_ROOT };
