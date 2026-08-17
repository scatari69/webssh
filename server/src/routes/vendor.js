'use strict';

const express = require('express');

const router = express.Router();

/**
 * Файлы xterm.js раздаются прямо из node_modules по явному списку.
 *
 * Список, а не каталог: имя файла приходит из запроса, и любое сопоставление
 * с путём открывало бы дорогу к выходу за пределы каталога. Здесь запрос
 * может попасть только в одно из пяти заранее известных значений.
 *
 * Копировать эти файлы в web/ на этапе сборки не нужно: пакеты поставляют
 * самодостаточные ESM-сборки, которые браузер грузит как есть.
 */
const FILES = {
  'xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
  'addon-search.mjs': '@xterm/addon-search/lib/addon-search.mjs',
  'addon-web-links.mjs': '@xterm/addon-web-links/lib/addon-web-links.mjs',
};

const CONTENT_TYPES = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const resolved = new Map();
for (const [name, specifier] of Object.entries(FILES)) {
  resolved.set(name, require.resolve(specifier));
}

router.get('/:file', (req, res, next) => {
  const path = resolved.get(req.params.file);
  if (!path) return next();

  const extension = req.params.file.slice(req.params.file.lastIndexOf('.'));
  res.type(CONTENT_TYPES[extension] || 'application/octet-stream');
  // Библиотека меняется только вместе с образом, но URL без хеша — час
  // кеша даёт выигрыш и не мешает выкатке.
  res.setHeader('Cache-Control', 'public, max-age=3600');

  return res.sendFile(path);
});

module.exports = router;
