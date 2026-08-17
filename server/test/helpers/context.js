'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Окружение выставляется ДО первого require('../src/config'): конфигурация
 * читается один раз при загрузке модуля и при нехватке переменных
 * завершает процесс. Значения ставятся только если не заданы снаружи,
 * чтобы отдельный тест мог задать своё (например, низкий лимит попыток).
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-test-'));

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SESSION_SECRET ||= crypto.randomBytes(48).toString('base64');
process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64');
process.env.DB_PATH ||= path.join(tmpRoot, 'test.sqlite');
process.env.SSH_KEYS_DIR ||= path.join(tmpRoot, 'keys');
process.env.PUBLIC_ORIGIN ||= 'http://localhost';
process.env.LOGIN_RATE_MAX_ATTEMPTS ||= '1000';
process.env.LOGIN_LOCKOUT_THRESHOLD ||= '1000';

const request = require('supertest');

const { createApp } = require('../../src/app');
const password = require('../../src/auth/password');
const { getDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const users = require('../../src/services/users');

const silentLogger = { info() {}, warn() {}, error() {} };

migrate({ logger: silentLogger });

const app = createApp();

/** Пароль по умолчанию для тестовых учёток: длиннее минимальных 12 символов. */
const DEFAULT_PASSWORD = 'test-password-123';

async function createUser({ username, role = 'user', password: raw = DEFAULT_PASSWORD, isActive = true }) {
  const user = users.create({
    username,
    passwordHash: await password.hash(raw),
    role,
    createdBy: null,
  });
  if (!isActive) users.setActive(user.id, false);
  return { ...user, password: raw };
}

/** Агент supertest хранит cookie между запросами — это и есть сессия. */
async function loginAs(username, raw = DEFAULT_PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/login').send({ username, password: raw });
  return { agent, res };
}

function resetDb() {
  const db = getDb();
  db.exec('DELETE FROM audit_log; DELETE FROM recovery_codes; DELETE FROM users;');
  db.exec(`UPDATE ssh_config
              SET host = '', port = 22, ssh_username = '', private_key_path = NULL,
                  private_key_fingerprint = NULL, private_key_type = NULL,
                  passphrase_enc = NULL, updated_by = NULL
            WHERE id = 1`);
}

function auditActions() {
  return getDb()
    .prepare('SELECT action, outcome, target_type, target_id, detail FROM audit_log ORDER BY id')
    .all();
}

module.exports = {
  app,
  request,
  createUser,
  loginAs,
  resetDb,
  auditActions,
  getDb,
  tmpRoot,
  DEFAULT_PASSWORD,
};
