'use strict';

const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

// Лимит задаётся до загрузки конфигурации. Блокировку учётной записи
// отодвигаем, чтобы она не сработала первой и не подменила проверяемый
// эффект.
process.env.LOGIN_RATE_MAX_ATTEMPTS = '5';
process.env.LOGIN_LOCKOUT_THRESHOLD = '1000';

const ctx = require('./helpers/context');

describe('ограничение частоты проверки второго фактора', () => {
  let agent;

  before(async () => {
    ctx.resetDb();
    await ctx.createUser({ username: 'admin', role: 'admin' });
    await ctx.loginAs('admin');

    agent = ctx.request.agent(ctx.app);
    const login = await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });
    assert.equal(login.body.mfa.enrolled, true);
  });

  it('после 5 неверных кодов перестаёт их проверять', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await agent.post('/api/totp/verify').send({ code: '000000' });
      assert.equal(res.status, 401, `попытка ${attempt} должна дойти до проверки кода`);
    }

    const blocked = await agent.post('/api/totp/verify').send({ code: '000000' });

    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, 'too_many_attempts');
  });

  it('счётчик отдельный от лимита на ввод пароля', async () => {
    // Вход паролем по-прежнему проходит: исчерпан лимит на /api/totp/verify,
    // а не на /api/login.
    const fresh = ctx.request.agent(ctx.app);
    const login = await fresh.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });

    assert.equal(login.status, 200);
    assert.equal(login.body.mfa.required, true);
  });
});
