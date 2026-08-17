'use strict';

const assert = require('node:assert/strict');
const { before, beforeEach, describe, it } = require('node:test');

const ctx = require('./helpers/context');

describe('аутентификация', () => {
  let admin;
  let member;

  beforeEach(async () => {
    ctx.resetDb();
    admin = await ctx.createUser({ username: 'admin', role: 'admin' });
    member = await ctx.createUser({ username: 'member', role: 'user' });
  });

  it('пускает с верными данными и возвращает роль', async () => {
    const { res } = await ctx.loginAs('admin');

    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'admin');
    assert.equal(res.body.user.role, 'admin');
    // Хеш пароля не должен утекать в ответ ни под каким именем.
    assert.equal(JSON.stringify(res.body).includes('$2b$'), false);
    assert.equal('password_hash' in res.body.user, false);
  });

  it('логин нечувствителен к регистру', async () => {
    const { res } = await ctx.loginAs('ADMIN');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'admin');
  });

  it('отвечает одинаково на неверный пароль и на неизвестного пользователя', async () => {
    const wrongPassword = await ctx.request(ctx.app)
      .post('/api/login')
      .send({ username: 'admin', password: 'definitely-not-it' });

    const unknownUser = await ctx.request(ctx.app)
      .post('/api/login')
      .send({ username: 'no-such-person', password: 'definitely-not-it' });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    // Одинаковый код — иначе по ответу перебирается список имён.
    assert.equal(wrongPassword.body.error, 'invalid_credentials');
    assert.equal(unknownUser.body.error, 'invalid_credentials');
  });

  it('отклоняет запрос без полей', async () => {
    const res = await ctx.request(ctx.app).post('/api/login').send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_request');
  });

  it('не пускает деактивированного пользователя', async () => {
    const disabled = await ctx.createUser({ username: 'disabled', isActive: false });
    const { res } = await ctx.loginAs(disabled.username);

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'account_disabled');
  });

  it('GET /api/me без сессии отдаёт 401', async () => {
    const res = await ctx.request(ctx.app).get('/api/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'unauthenticated');
  });

  it('GET /api/me с сессией отдаёт текущего пользователя', async () => {
    const { agent } = await ctx.loginAs('member');
    const res = await agent.get('/api/me');

    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'member');
    assert.equal(res.body.user.role, 'user');
  });

  it('после logout сессия недействительна', async () => {
    const { agent } = await ctx.loginAs('member');

    const logout = await agent.post('/api/logout');
    assert.equal(logout.status, 200);

    const after = await agent.get('/api/me');
    assert.equal(after.status, 401);
  });

  it('деактивация действует немедленно, не дожидаясь истечения cookie', async () => {
    const { agent } = await ctx.loginAs('member');
    assert.equal((await agent.get('/api/me')).status, 200);

    const { agent: adminAgent } = await ctx.loginAs('admin');
    await adminAgent.delete(`/api/admin/users/${member.id}`);

    const after = await agent.get('/api/me');
    assert.equal(after.status, 403);
    assert.equal(after.body.error, 'account_disabled');
  });

  it('пишет в журнал и успешный, и неудачный вход', async () => {
    await ctx.loginAs('admin');
    await ctx.request(ctx.app).post('/api/login').send({ username: 'admin', password: 'nope' });
    await ctx.request(ctx.app).post('/api/login').send({ username: 'ghost', password: 'nope' });

    const logins = ctx.auditActions().filter((row) => row.action === 'auth.login');

    assert.equal(logins.length, 3);
    assert.equal(logins[0].outcome, 'success');
    assert.equal(logins[1].outcome, 'failure');
    assert.equal(logins[2].outcome, 'failure');
    // Попытка входа под несуществующим именем тоже должна быть видна.
    assert.match(logins[2].detail, /unknown_user/);
  });

  it('в журнал не попадает сам пароль', async () => {
    await ctx.request(ctx.app)
      .post('/api/login')
      .send({ username: 'admin', password: 'super-secret-value' });

    const dump = JSON.stringify(ctx.auditActions());
    assert.equal(dump.includes('super-secret-value'), false);
  });
});

describe('сессия и смена пароля', () => {
  before(() => ctx.resetDb());

  it('сброс пароля администратором обрывает уже открытую сессию', async () => {
    ctx.resetDb();
    await ctx.createUser({ username: 'admin', role: 'admin' });
    const victim = await ctx.createUser({ username: 'victim' });

    const { agent } = await ctx.loginAs('victim');
    assert.equal((await agent.get('/api/me')).status, 200);

    const { agent: adminAgent } = await ctx.loginAs('admin');
    const reset = await adminAgent
      .patch(`/api/admin/users/${victim.id}/password`)
      .send({ password: 'brand-new-password' });
    assert.equal(reset.status, 200);

    const after = await agent.get('/api/me');
    assert.equal(after.status, 401);
    assert.equal(after.body.error, 'session_expired');
  });
});
