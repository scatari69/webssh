'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const config = require('./config');
const { createApp } = require('./app');
const { closeDb } = require('./db');
const { migrate } = require('./db/migrate');
const { seed } = require('./db/seed');
const manager = require('./ssh/manager');
const { createWebSocketServer } = require('./ws/server');

/**
 * Каталоги данных подключены bind-mount'ом из каталога проекта, и владельца
 * из образа они, в отличие от именованного тома, не наследуют: на хосте
 * каталог остаётся с теми правами, с какими его создали. Процесс работает
 * под непривилегированным uid и выправить их себе не может.
 *
 * Без этой проверки первым признаком беды был бы SQLITE_CANTOPEN из
 * драйвера БД — сообщение, по которому причину не угадать. Поэтому
 * проверяем доступ явно и печатаем ровно ту команду, которая чинит.
 */
function assertWritable(dir, label) {
  /*
   * Сначала проверяем существование, и только потом создаём. Порядок
   * важен: mkdir на уже существующем каталоге возвращает EACCES, а не
   * EEXIST, если у процесса нет права записи в РОДИТЕЛЬСКИЙ каталог — а
   * это ровно боевая расстановка, где каталог проекта принадлежит тому,
   * кто разворачивает, а data/ и keys/ — непривилегированному uid
   * приложения. С mkdir впереди проверка валила бы старт даже после
   * правильно выставленных прав.
   */
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      failPermissions(dir, label, `каталог не удалось создать (${err.code})`);
    }
  }

  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
  } catch (err) {
    failPermissions(dir, label, `нет доступа на запись (${err.code})`);
  }
}

function failPermissions(dir, label, reason) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
  const gid = typeof process.getgid === 'function' ? process.getgid() : '?';

  console.error(
    `\n${label} (${dir}): ${reason}.\n\n` +
      `Процесс работает под uid ${uid}:${gid}, а каталог подключён из каталога\n` +
      'проекта на хосте и владельца из образа не наследует. Выполните на хосте,\n' +
      'из каталога проекта:\n\n' +
      `    mkdir -p data keys\n` +
      `    sudo chown -R ${uid}:${gid} data keys\n` +
      '    sudo chmod 700 data keys\n'
  );
  process.exit(1);
}

function prepareDataDirs() {
  assertWritable(config.db.dir, 'Каталог базы данных');
  // Приватный ключ хоста будет лежать здесь файлом с правами 0600.
  assertWritable(config.ssh.keysDir, 'Каталог приватного ключа');

  try {
    fs.chmodSync(config.ssh.keysDir, 0o700);
  } catch {
    // На некоторых файловых системах chmod недоступен — не повод не
    // стартовать: сам файл ключа всё равно пишется с правами 0600.
  }
}

function main() {
  prepareDataDirs();
  migrate();
  seed();

  const app = createApp();
  const server = http.createServer(app);

  // WebSocket висит на 'upgrade' того же http.Server: общий порт и, что
  // важнее, та же cookie сессии, что и у REST API.
  createWebSocketServer({ server, sessionMiddleware: app.get('sessionMiddleware') });

  server.listen(config.port, '0.0.0.0', () => {
    console.info(`[server] слушает 0.0.0.0:${config.port} (env: ${config.env})`);
    console.info(`[server] публичный origin: ${config.publicOrigin}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[server] получен ${signal}, останавливаюсь`);

    // Терминальные сессии закрываем явно: server.close() ждёт завершения
    // соединений, а WebSocket сам по себе не закроется никогда.
    manager.closeAll();
    manager.stopIdleSweeper();

    server.close(() => {
      closeDb();
      console.info('[server] остановлен');
      process.exit(0);
    });

    // Если соединения не закрылись сами (а WebSocket-сессии терминала
    // не закроются), добиваем принудительно.
    setTimeout(() => {
      console.warn('[server] штатная остановка не уложилась в 10 с, выхожу принудительно');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
