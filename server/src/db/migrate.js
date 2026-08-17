'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { getDb, getSchemaVersion, setSchemaVersion, MIGRATIONS_DIR, closeDb } = require('./index');

/**
 * Миграции — нумерованные .sql файлы (001_init.sql, 002_….sql). Применяются
 * по порядку, все с номером больше текущего PRAGMA user_version. Каждая идёт
 * в собственной транзакции вместе с обновлением версии: прерывание на
 * середине не оставит схему в промежуточном состоянии.
 */

function loadMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      if (!match) {
        throw new Error(`Файл миграции "${name}" должен начинаться с номера, например 002_add_x.sql`);
      }
      return { version: Number(match[1]), name, file: path.join(MIGRATIONS_DIR, name) };
    })
    .sort((a, b) => a.version - b.version);
}

function migrate({ logger = console } = {}) {
  const db = getDb();
  const migrations = loadMigrations();
  const currentVersion = getSchemaVersion();
  const pending = migrations.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    logger.info(`[migrate] схема актуальна (версия ${currentVersion})`);
    return { applied: [], version: currentVersion };
  }

  const applied = [];
  for (const migration of pending) {
    const sql = fs.readFileSync(migration.file, 'utf8');

    // exec() не работает внутри db.transaction(), поэтому транзакцией
    // управляем вручную.
    db.exec('BEGIN');
    try {
      db.exec(sql);
      setSchemaVersion(migration.version);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`[migrate] миграция ${migration.name} провалилась: ${err.message}`);
    }

    logger.info(`[migrate] применена ${migration.name}`);
    applied.push(migration.name);
  }

  const version = getSchemaVersion();
  logger.info(`[migrate] схема обновлена до версии ${version}`);
  return { applied, version };
}

module.exports = { migrate };

if (require.main === module) {
  try {
    migrate();
    closeDb();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
