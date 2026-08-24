'use strict';

/**
 * Общая обвязка сквозных проверок в настоящем браузере.
 *
 * Наборы в этом каталоге проверяют то, чего серверные тесты увидеть не
 * могут: что показано человеку на экране и что страница делает с ответом
 * сервера. Оба последних дефекта — потерянный пароль при самосбросе и
 * бесконечное «переподключение» — жили ровно там: сервер вёл себя
 * правильно, а страница распоряжалась его ответом неверно.
 *
 * Каждый набор запускается отдельным процессом. Это не аккуратность, а
 * необходимость: конфигурация приложения читается из окружения один раз
 * при загрузке модуля, а наборам нужны разные PUBLIC_ORIGIN и разные
 * порты. В одном процессе второй набор получил бы конфигурацию первого.
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/** Каталог server/ и корень репозитория: обвязка лежит в server/test/e2e. */
const SERVER_DIR = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(SERVER_DIR, '..');

/** Код выхода, которым набор сообщает «условия не выполнены, я не бежал». */
const SKIP_CODE = 99;

/* --------------------------------------------------------- playwright */

/**
 * Playwright намеренно не записан в зависимости: он тянет за собой
 * browser-бинарники в сотни мегабайт, и обычной сборке образа они не
 * нужны. Поэтому модуль ищется, а не требуется, и при его отсутствии
 * набор помечается пропущенным, а не падает.
 */
function findPlaywright() {
  const candidates = [];

  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);

  // Установленный в сам проект — обычный путь для того, кто эти проверки гоняет.
  candidates.push(path.join(ROOT, 'server', 'node_modules', 'playwright'));

  // Глобальная установка: спрашиваем сам npm, где у него корень.
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (globalRoot) candidates.push(path.join(globalRoot, 'playwright'));
  } catch {
    // npm может быть недоступен — не повод прекращать поиск.
  }

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Следующий кандидат.
    }
  }
  return null;
}

/**
 * Нехватка окружения — не провал: набору просто не на чем бежать.
 * Выход здесь немедленный и по отдельному коду, потому что проверять
 * условия приходится ещё на загрузке модуля, до входа в тело набора.
 */
function skip(message) {
  console.log(`SKIP: ${message}`);
  process.exit(SKIP_CODE);
}

/** @returns {{chromium: object, devices: object}} */
function requirePlaywright() {
  const playwright = findPlaywright();
  if (!playwright) {
    skip(
      'playwright не найден. Поставьте его в server/ ' +
        '(npm i -D playwright && npx playwright install chromium) ' +
        'или укажите путь к модулю в PLAYWRIGHT_MODULE.'
    );
  }
  return playwright;
}

/**
 * Настоящий sshd нужен всем наборам, где открывается терминал. В образе
 * приложения (node:20-alpine) его нет — там набор пропускается, как и
 * серверные тесты терминала.
 *
 * @returns {object} модуль-помощник test/helpers/sshd
 */
function requireSshd() {
  const sshd = require('../helpers/sshd');
  if (!sshd.isAvailable()) skip('sshd/ssh-keygen недоступны: настоящий SSH-хост не поднять');
  return sshd;
}

/* ------------------------------------------------------------- прочее */

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Снимки экрана кладём рядом с наборами и не коммитим: они полезны, когда
 * проверка упала, и бесполезны в истории.
 */
function shotsDir() {
  const dir = process.env.E2E_SHOTS || path.join(__dirname, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Порт выбирается ДО загрузки конфигурации приложения: проверка заголовка
 * Origin при upgrade сверяет его с PUBLIC_ORIGIN дословно, вместе с
 * портом. Загрузить конфигурацию раньше — значит получить 403 на
 * рукопожатии в каждом наборе.
 *
 * @param {{publicOrigin?: string}} [options] переопределение PUBLIC_ORIGIN
 *   для наборов, которые проверяют как раз несовпадение
 */
async function bootApp(options = {}) {
  const port = await freePort();
  process.env.PUBLIC_ORIGIN = options.publicOrigin || `http://127.0.0.1:${port}`;

  const ctx = require('../helpers/context');
  const wsClient = require('../helpers/wsClient');
  const server = await wsClient.startServer(ctx.app, port);

  return { port, ctx, wsClient, server };
}

/** Полная остановка: иначе процесс не завершится из-за живых сокетов. */
async function shutdown({ browser, server, host, reason = 'e2e_done' } = {}) {
  const manager = require('../../src/ssh/manager');
  if (browser) await browser.close();
  manager.closeAll(reason);
  manager.stopIdleSweeper();
  if (server) await server.close();
  if (host) await host.stop();
}

/* ---------------------------------------------------------- отчётность */

class Report {
  constructor(title) {
    this.title = title;
    this.passed = 0;
    this.failed = 0;
    this.failures = [];
  }

  check(name, ok, extra = '') {
    if (ok) this.passed += 1;
    else {
      this.failed += 1;
      this.failures.push(name);
    }
    console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
  }

  /** @returns {number} код выхода */
  finish() {
    console.log(`\nитого: ${this.passed} успешно, ${this.failed} неудачно`);
    return this.failed ? 1 : 0;
  }
}

/**
 * Обёртка вокруг тела набора: считает проверки и выходит нужным кодом.
 * Выход обязателен: живой сокет или неостановленный таймер удержат
 * процесс, и прогон повиснет вместо того, чтобы завершиться.
 *
 * @param {string} title название набора
 * @param {(report: Report) => Promise<void>} body
 */
function run(title, body) {
  const report = new Report(title);
  body(report)
    .then(() => process.exit(report.finish()))
    .catch((err) => {
      console.error('сценарий упал:', err);
      process.exit(1);
    });
}

module.exports = {
  ROOT,
  SERVER_DIR,
  SKIP_CODE,
  Report,
  bootApp,
  freePort,
  requirePlaywright,
  requireSshd,
  skip,
  run,
  shotsDir,
  shutdown,
};
