'use strict';

const crypto = require('node:crypto');

const bcrypt = require('bcrypt');

const config = require('../config');
const { getDb, closeDb } = require('./index');

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 12;

/**
 * Пароль генерируется, если ADMIN_INITIAL_PASSWORD не задан: так
 * `docker compose up` работает «из коробки», не заводя при этом учётку с
 * предсказуемым паролем. base64url от 18 случайных байт — 24 символа.
 */
function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

/**
 * Создаёт первого администратора, если таблица users пуста. Идемпотентно:
 * при каждом последующем старте не делает ничего.
 */
function seed({ logger = console } = {}) {
  const db = getDb();

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count > 0) {
    logger.info('[seed] пользователи уже есть, сидинг пропущен');
    return { created: false };
  }

  const username = config.bootstrap.adminUsername;
  const provided = config.bootstrap.adminPassword;
  const generated = !provided;
  const password = provided || generatePassword();

  if (provided && provided.length < MIN_PASSWORD_LENGTH) {
    logger.warn(
      `[seed] ADMIN_INITIAL_PASSWORD короче ${MIN_PASSWORD_LENGTH} символов. ` +
        'Приложение доступно из интернета — смените пароль после первого входа.'
    );
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_COST);
  const now = new Date().toISOString();

  const createUser = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO users (username, password_hash, role, is_active, password_changed_at, created_at, updated_at)
         VALUES (?, ?, 'admin', 1, ?, ?, ?)`
      )
      .run(username, passwordHash, now, now, now);

    db.prepare(
      `INSERT INTO audit_log (user_id, actor_username, action, outcome, target_type, target_id, detail, created_at)
       VALUES (NULL, 'system', 'user.created', 'success', 'user', ?, ?, ?)`
    ).run(
      String(result.lastInsertRowid),
      JSON.stringify({ username, role: 'admin', reason: 'bootstrap', password_generated: generated }),
      now
    );

    return result.lastInsertRowid;
  });

  const userId = createUser();

  if (generated) {
    // Единственный момент, когда пароль виден. В аудит и в БД он не попадает.
    logger.warn(
      '\n' +
        '='.repeat(72) +
        '\n  Создан администратор. Пароль сгенерирован и показывается ОДИН РАЗ:\n\n' +
        `      логин:  ${username}\n` +
        `      пароль: ${password}\n\n` +
        '  Сохраните его сейчас. Восстановить нельзя — только сбросить,\n' +
        '  удалив файл БД или через другого администратора.\n' +
        '='.repeat(72) +
        '\n'
    );
  } else {
    logger.info(`[seed] создан администратор "${username}" с паролем из ADMIN_INITIAL_PASSWORD`);
    logger.info('[seed] после первого входа уберите ADMIN_INITIAL_PASSWORD из .env');
  }

  return { created: true, userId, username, generated };
}

module.exports = { seed, BCRYPT_COST };

if (require.main === module) {
  try {
    seed();
    closeDb();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
