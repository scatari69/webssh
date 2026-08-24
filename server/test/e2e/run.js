'use strict';

/**
 * Прогон всех сквозных наборов.
 *
 * Каждый набор — отдельный процесс: конфигурация приложения читается из
 * окружения один раз при загрузке модуля, а наборам нужны разные
 * PUBLIC_ORIGIN и разные порты. Последовательно, а не разом: каждый
 * поднимает свой Chromium, свой sshd и свой сервер, и на маленькой машине
 * параллельный запуск упирается в память раньше, чем даёт выигрыш.
 *
 * Набор, которому не на чем бежать (нет playwright, нет sshd, нет caddy),
 * выходит кодом 99 и считается пропущенным, а не упавшим: отсутствие
 * браузера в окружении — не то же самое, что сломанный фронтенд.
 *
 *   node test/e2e/run.js            все наборы
 *   node test/e2e/run.js admin      только совпадающие по имени
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { SKIP_CODE } = require('./harness');

const DIR = __dirname;

function suites(filters) {
  const all = fs
    .readdirSync(DIR)
    .filter((name) => name.endsWith('.e2e.js'))
    .sort();
  if (!filters.length) return all;
  return all.filter((name) => filters.some((f) => name.includes(f)));
}

function runSuite(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(DIR, name)], { stdio: 'inherit' });
    child.on('exit', (code) => resolve({ name, code, seconds: Math.round((Date.now() - started) / 1000) }));
  });
}

(async () => {
  const list = suites(process.argv.slice(2));
  if (!list.length) {
    console.error('наборы не найдены');
    process.exit(1);
  }

  const results = [];
  for (const name of list) {
    console.log(`\n${'='.repeat(70)}\n${name}\n${'='.repeat(70)}`);
    results.push(await runSuite(name));
  }

  console.log(`\n${'='.repeat(70)}\nсводка\n${'='.repeat(70)}`);
  for (const { name, code, seconds } of results) {
    const verdict = code === 0 ? 'успешно' : code === SKIP_CODE ? 'пропущен' : 'НЕУДАЧА';
    console.log(`  ${verdict.padEnd(9)} ${name.padEnd(22)} ${seconds} с`);
  }

  const failed = results.filter((r) => r.code !== 0 && r.code !== SKIP_CODE);
  const skipped = results.filter((r) => r.code === SKIP_CODE);
  console.log(
    `\nнаборов: ${results.length}, успешно: ${results.length - failed.length - skipped.length}, ` +
      `пропущено: ${skipped.length}, неудачно: ${failed.length}`
  );
  process.exit(failed.length ? 1 : 0);
})();
