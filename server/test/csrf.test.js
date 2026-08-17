'use strict';

const assert = require('node:assert/strict');
const { beforeEach, describe, it } = require('node:test');

const ctx = require('./helpers/context');
const keys = require('./helpers/keys');

/**
 * Проверки нарочно ходят голым агентом, без обёртки withCsrf: смысл набора
 * именно в том, что происходит, когда токена нет или он чужой.
 */
describe('защита от межсайтовой подделки запросов', () => {
  let admin;
  let token;

  beforeEach(async () => {
    ctx.resetDb();
    await ctx.createUser({ username: 'admin', role: 'admin' });
    await ctx.createUser({ username: 'member', role: 'user' });

    const login = await ctx.loginAs('admin');
    admin = login.agent;
    token = login.csrfToken;
  });

  it('токен выдаётся при входе и совпадает с тем, что отдаёт /api/me', async () => {
    assert.ok(token, 'вход должен вернуть csrf_token');
    assert.ok(token.length >= 32, `токен слишком короткий: ${token.length}`);

    const me = await admin.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.csrf_token, token);
  });

  it('мутирующий запрос без токена отклоняется', async () => {
    const { agent } = await ctx.loginAs('admin');
    // Снимаем обёртку: обращаемся к тому же агенту, но без заголовка.
    const res = await agent.post('/api/admin/users').set('X-CSRF-Token', '').send({
      username: 'ghost',
      role: 'user',
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'csrf_token_invalid');
    assert.equal(ctx.getDb().prepare("SELECT 1 FROM users WHERE username = 'ghost'").get(), undefined);
  });

  it('чужой токен той же длины не подходит', async () => {
    const forged = 'x'.repeat(token.length);
    const res = await admin.post('/api/admin/users').set('X-CSRF-Token', forged).send({
      username: 'ghost',
      role: 'user',
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'csrf_token_invalid');
  });

  it('токен другой сессии не подходит', async () => {
    const other = await ctx.loginAs('member');

    const res = await admin.post('/api/admin/users').set('X-CSRF-Token', other.csrfToken).send({
      username: 'ghost',
      role: 'user',
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'csrf_token_invalid');
  });

  it('с верным токеном запрос проходит', async () => {
    const res = await admin.post('/api/admin/users').set('X-CSRF-Token', token).send({
      username: 'legit',
      role: 'user',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.user.username, 'legit');
  });

  it('закрыты все мутирующие методы, а не только POST', async () => {
    const created = await admin
      .post('/api/admin/users')
      .set('X-CSRF-Token', token)
      .send({ username: 'victim', role: 'user' });
    const id = created.body.user.id;

    const cases = [
      ['put', '/api/admin/ssh-config', { host: '10.0.0.1', port: 22, ssh_username: 'deploy' }],
      ['patch', `/api/admin/users/${id}`, { is_active: false }],
      ['patch', `/api/admin/users/${id}/password`, {}],
      ['delete', `/api/admin/users/${id}`, {}],
      ['delete', `/api/admin/users/${id}/totp`, {}],
      ['post', '/api/logout', {}],
    ];

    for (const [method, path, body] of cases) {
      const res = await admin[method](path).set('X-CSRF-Token', 'nope').send(body);
      assert.equal(res.status, 403, `${method.toUpperCase()} ${path} должен требовать токен`);
      assert.equal(res.body.error, 'csrf_token_invalid', `${method.toUpperCase()} ${path}`);
    }

    // Учётная запись не пострадала ни от одного из отклонённых запросов.
    const victim = ctx.getDb().prepare('SELECT is_active FROM users WHERE id = ?').get(id);
    assert.equal(victim.is_active, 1);
  });

  it('чтение токена не требует', async () => {
    for (const path of ['/api/me', '/api/admin/users', '/api/admin/ssh-config', '/api/admin/audit']) {
      const res = await admin.get(path).set('X-CSRF-Token', '');
      assert.equal(res.status, 200, path);
    }
  });

  it('вход исключён из проверки: иначе форма входа стала бы неработоспособной', async () => {
    // Промежуточная сессия уже существует и несёт токен — повторный вход с
    // той же вкладки не должен упираться в 403.
    const agent = ctx.request.agent(ctx.app);

    const first = await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });
    assert.equal(first.status, 200);
    assert.ok(first.body.csrf_token);

    const second = await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });
    assert.notEqual(second.status, 403);
  });

  it('токен перевыпускается вместе с сессией', async () => {
    const again = await ctx.loginAs('admin');
    assert.ok(again.csrfToken);
    assert.notEqual(again.csrfToken, token, 'новый вход должен выдать новый токен');
  });

  it('подделанный запрос не меняет SSH-конфигурацию', async () => {
    const before = await admin.get('/api/admin/ssh-config');

    const res = await admin.put('/api/admin/ssh-config').set('X-CSRF-Token', 'forged').send({
      host: 'evil.example.com',
      port: 22,
      ssh_username: 'root',
      private_key: keys.generateEd25519OpenSsh(),
    });

    assert.equal(res.status, 403);

    const after = await admin.get('/api/admin/ssh-config');
    assert.deepEqual(after.body.ssh_config, before.body.ssh_config);
  });
});
