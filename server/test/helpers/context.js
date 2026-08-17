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
const totp = require('../../src/auth/totp');
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

/**
 * Секреты TOTP, привязанные хелпером, чтобы повторный вход тем же
 * пользователем не начинал привязку заново.
 */
const enrolledSecrets = new Map();

const CSRF_VERBS = new Set(['post', 'put', 'patch', 'delete', 'del']);

/**
 * Агент supertest, сам подставляющий CSRF-токен в мутирующие запросы.
 *
 * В браузере это делает обёртка над fetch, и требовать от каждого теста
 * ручного .set() значило бы проверять не то поведение, которое существует в
 * бою. Отсутствие токена проверяется отдельным набором — на голом агенте.
 */
function withCsrf(agent, token) {
  if (!token) return agent;
  return new Proxy(agent, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (!CSRF_VERBS.has(prop)) return value.bind(target);
      return (...args) => value.apply(target, args).set('X-CSRF-Token', token);
    },
  });
}

/**
 * Агент supertest хранит cookie между запросами — это и есть сессия.
 *
 * Вход доводится до конца, включая второй фактор: администраторам он
 * обязателен по умолчанию, и без этого наборы про админский API проверяли
 * бы поток, которого в бою не существует. Возвращается ответ последнего
 * шага — того, который выдаёт полноценную сессию.
 */
/**
 * Первая ступень входа: пароль принят, второй фактор ещё нет.
 *
 * Возвращает агент, который уже подставляет CSRF-токен промежуточной
 * сессии, — ровно то же самое делает страница входа, забирая токен из
 * ответа /api/login.
 */
async function beginLogin(username, raw = DEFAULT_PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/login').send({ username, password: raw });
  return { agent: withCsrf(agent, res.body.csrf_token), res, csrfToken: res.body.csrf_token };
}

async function loginAs(username, raw = DEFAULT_PASSWORD) {
  const agent = request.agent(app);
  const key = username.toLowerCase();

  let res = await agent.post('/api/login').send({ username, password: raw });
  if (res.status !== 200 || !res.body.mfa || !res.body.mfa.required) {
    return { agent: withCsrf(agent, res.body.csrf_token), res, csrfToken: res.body.csrf_token };
  }

  // Токен промежуточной сессии: шаги привязки и подтверждения уже мутирующие.
  let token = res.body.csrf_token;

  if (!res.body.mfa.enrolled) {
    const enroll = await agent.post('/api/totp/enroll').send({}).set('X-CSRF-Token', token);
    enrolledSecrets.set(key, enroll.body.secret);
    res = await agent
      .post('/api/totp/confirm')
      .send({ code: totp.generateToken(enroll.body.secret) })
      .set('X-CSRF-Token', token);
    token = res.body.csrf_token || token;
    return { agent: withCsrf(agent, token), res, secret: enroll.body.secret, csrfToken: token };
  }

  const secret = enrolledSecrets.get(key);
  if (!secret) throw new Error(`нет сохранённого TOTP-секрета для "${username}"`);

  // Только для тестов: настоящий вход дважды за один 30-секундный шаг
  // получил бы отказ по защите от повторного кода. Она проверяется
  // отдельным тестом, а здесь мешала бы наборам про другие вещи.
  getDb().prepare('UPDATE users SET totp_last_step = NULL WHERE username = ? COLLATE NOCASE').run(username);

  res = await agent
    .post('/api/totp/verify')
    .send({ code: totp.generateToken(secret) })
    .set('X-CSRF-Token', token);
  token = res.body.csrf_token || token;
  return { agent: withCsrf(agent, token), res, secret, csrfToken: token };
}

function resetDb() {
  const db = getDb();
  enrolledSecrets.clear();

  // Живые терминальные сессии закрываем до удаления пользователей: иначе
  // их запись о закрытии сошлётся на уже удалённую строку.
  require('../../src/ssh/manager').closeAll('test_reset');
  db.exec('DELETE FROM audit_log; DELETE FROM recovery_codes; DELETE FROM users;');
  // Выученный ключ хоста тоже обнуляется: без этого он переживал бы сброс
  // и ломал следующий набор чужим состоянием.
  db.exec(`UPDATE ssh_config
              SET host = '', port = 22, ssh_username = '', private_key_path = NULL,
                  private_key_fingerprint = NULL, private_key_type = NULL,
                  passphrase_enc = NULL, host_key_policy = 'tofu',
                  known_host_key = NULL, known_host_fingerprint = NULL,
                  updated_by = NULL
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
  beginLogin,
  loginAs,
  withCsrf,
  resetDb,
  auditActions,
  getDb,
  totp,
  tmpRoot,
  DEFAULT_PASSWORD,
};
