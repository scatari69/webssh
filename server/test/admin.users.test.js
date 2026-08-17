'use strict';

const assert = require('node:assert/strict');
const { beforeEach, describe, it } = require('node:test');

const ctx = require('./helpers/context');

describe('админ API: пользователи', () => {
  let adminAgent;

  beforeEach(async () => {
    ctx.resetDb();
    await ctx.createUser({ username: 'admin', role: 'admin' });
    await ctx.createUser({ username: 'member', role: 'user' });
    ({ agent: adminAgent } = await ctx.loginAs('admin'));
  });

  describe('доступ', () => {
    it('без сессии — 401', async () => {
      const res = await ctx.request(ctx.app).get('/api/admin/users');
      assert.equal(res.status, 401);
    });

    it('обычному пользователю — 403', async () => {
      const { agent } = await ctx.loginAs('member');
      const res = await agent.get('/api/admin/users');

      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'forbidden');
    });
  });

  describe('список', () => {
    it('отдаёт пользователей без секретов', async () => {
      const res = await adminAgent.get('/api/admin/users');

      assert.equal(res.status, 200);
      assert.equal(res.body.users.length, 2);

      const dump = JSON.stringify(res.body);
      assert.equal(dump.includes('$2b$'), false);
      assert.equal(dump.includes('password_hash'), false);
      assert.equal(dump.includes('totp_secret'), false);
    });
  });

  describe('создание', () => {
    it('генерирует временный пароль, если он не задан, и им можно войти', async () => {
      const res = await adminAgent.post('/api/admin/users').send({ username: 'newbie', role: 'user' });

      assert.equal(res.status, 201);
      assert.equal(res.body.user.username, 'newbie');
      assert.ok(res.body.temporary_password, 'временный пароль должен вернуться один раз');

      const { res: login } = await ctx.loginAs('newbie', res.body.temporary_password);
      assert.equal(login.status, 200);
    });

    it('принимает заданный пароль и не возвращает его обратно', async () => {
      const res = await adminAgent
        .post('/api/admin/users')
        .send({ username: 'chosen', role: 'user', password: 'chosen-password-1' });

      assert.equal(res.status, 201);
      assert.equal(res.body.temporary_password, undefined);

      const { res: login } = await ctx.loginAs('chosen', 'chosen-password-1');
      assert.equal(login.status, 200);
    });

    it('отклоняет короткий пароль', async () => {
      const res = await adminAgent
        .post('/api/admin/users')
        .send({ username: 'weak', role: 'user', password: 'short' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'password_too_short');
    });

    it('отклоняет пароль длиннее 72 байт, а не обрезает его молча', async () => {
      const res = await adminAgent
        .post('/api/admin/users')
        .send({ username: 'verbose', role: 'user', password: 'x'.repeat(73) });

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'password_too_long');
    });

    it('отклоняет недопустимую роль', async () => {
      const res = await adminAgent.post('/api/admin/users').send({ username: 'root', role: 'superuser' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'role_invalid');
    });

    it('отклоняет занятое имя без учёта регистра', async () => {
      const res = await adminAgent.post('/api/admin/users').send({ username: 'MEMBER', role: 'user' });

      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'username_taken');
    });

    it('пишет в журнал создание, но не пароль', async () => {
      const res = await adminAgent.post('/api/admin/users').send({ username: 'audited', role: 'user' });

      const created = ctx.auditActions().find((row) => row.action === 'user.created');
      assert.ok(created);
      assert.equal(created.target_id, String(res.body.user.id));
      assert.equal(JSON.stringify(ctx.auditActions()).includes(res.body.temporary_password), false);
    });
  });

  describe('сброс пароля', () => {
    it('старый пароль перестаёт работать, новый работает', async () => {
      const target = await ctx.createUser({ username: 'resetme' });

      const res = await adminAgent
        .patch(`/api/admin/users/${target.id}/password`)
        .send({ password: 'a-fresh-password' });
      assert.equal(res.status, 200);

      const { res: oldLogin } = await ctx.loginAs('resetme', ctx.DEFAULT_PASSWORD);
      assert.equal(oldLogin.status, 401);

      const { res: newLogin } = await ctx.loginAs('resetme', 'a-fresh-password');
      assert.equal(newLogin.status, 200);
    });

    it('генерирует пароль, если он не передан', async () => {
      const target = await ctx.createUser({ username: 'generated' });

      const res = await adminAgent.patch(`/api/admin/users/${target.id}/password`).send({});

      assert.equal(res.status, 200);
      assert.ok(res.body.temporary_password);

      const { res: login } = await ctx.loginAs('generated', res.body.temporary_password);
      assert.equal(login.status, 200);
    });

    it('404 для несуществующего пользователя', async () => {
      const res = await adminAgent.patch('/api/admin/users/9999/password').send({});
      assert.equal(res.status, 404);
    });
  });

  describe('деактивация', () => {
    it('DELETE деактивирует, но строку сохраняет', async () => {
      const target = await ctx.createUser({ username: 'goodbye' });

      const res = await adminAgent.delete(`/api/admin/users/${target.id}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.deactivated, true);
      assert.equal(res.body.user.is_active, false);

      // Строка на месте — иначе оборвались бы ссылки из audit_log.
      const list = await adminAgent.get('/api/admin/users');
      assert.ok(list.body.users.some((u) => u.username === 'goodbye'));

      const { res: login } = await ctx.loginAs('goodbye');
      assert.equal(login.status, 403);
    });

    it('PATCH возвращает учётную запись обратно в строй', async () => {
      const target = await ctx.createUser({ username: 'backagain', isActive: false });

      const res = await adminAgent.patch(`/api/admin/users/${target.id}`).send({ is_active: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.is_active, true);

      const { res: login } = await ctx.loginAs('backagain');
      assert.equal(login.status, 200);
    });

    it('не даёт отключить последнего активного администратора', async () => {
      const admins = (await adminAgent.get('/api/admin/users')).body.users.filter((u) => u.role === 'admin');
      assert.equal(admins.length, 1, 'в этом тесте админ должен быть один');

      const res = await adminAgent.delete(`/api/admin/users/${admins[0].id}`);

      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'last_admin');
    });

    it('разрешает отключить администратора, когда есть второй', async () => {
      const second = await ctx.createUser({ username: 'admin2', role: 'admin' });

      const res = await adminAgent.delete(`/api/admin/users/${second.id}`);
      assert.equal(res.status, 200);
    });

    it('404 для несуществующего и 400 для нечислового id', async () => {
      assert.equal((await adminAgent.delete('/api/admin/users/9999')).status, 404);
      assert.equal((await adminAgent.delete('/api/admin/users/abc')).status, 400);
    });
  });
});
