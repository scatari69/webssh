'use strict';

const fs = require('node:fs');
const http = require('node:http');

const config = require('./config');
const { createApp } = require('./app');
const { closeDb } = require('./db');
const { migrate } = require('./db/migrate');
const { seed } = require('./db/seed');
const manager = require('./ssh/manager');
const { createWebSocketServer } = require('./ws/server');

function prepareKeysDir() {
  // Приватный ключ хоста будет лежать здесь файлом с правами 0600.
  // Каталог доступен только владельцу — это том, а не образ, поэтому
  // права выставляются на старте, а не в Dockerfile.
  fs.mkdirSync(config.ssh.keysDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(config.ssh.keysDir, 0o700);
  } catch {
    // На некоторых томах chmod недоступен — не повод не стартовать.
  }
}

function main() {
  prepareKeysDir();
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
