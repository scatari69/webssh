'use strict';

const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const config = require('../config');

let db = null;

/**
 * Соединение с SQLite. better-sqlite3 синхронный, поэтому одного соединения
 * на процесс достаточно и оно же исключает гонки внутри процесса.
 */
function getDb() {
  if (db) return db;

  fs.mkdirSync(config.db.dir, { recursive: true, mode: 0o700 });

  db = new Database(config.db.path);

  // WAL: читатели не блокируют писателя. Для интерактивного приложения, где
  // терминальные сессии постоянно что-то пишут в аудит, это заметно.
  db.pragma('journal_mode = WAL');
  // Без этого SQLite молча игнорирует REFERENCES — флаг выключен по умолчанию.
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  // Файл БД содержит хеши паролей и зашифрованные секреты — доступ только
  // владельцу. Том может быть создан с более широкими правами.
  try {
    fs.chmodSync(config.db.path, 0o600);
  } catch {
    // Не критично: на некоторых файловых системах chmod недоступен.
  }

  return db;
}

function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}

/** Порядковый номер применённой миграции хранится в PRAGMA user_version. */
function getSchemaVersion() {
  return getDb().pragma('user_version', { simple: true });
}

function setSchemaVersion(version) {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Некорректная версия схемы: ${version}`);
  }
  // PRAGMA не принимает плейсхолдеры, поэтому значение валидируется выше.
  getDb().pragma(`user_version = ${version}`);
}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

module.exports = { getDb, closeDb, getSchemaVersion, setSchemaVersion, MIGRATIONS_DIR };
