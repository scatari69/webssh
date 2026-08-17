'use strict';

const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

// Лимит задаётся ДО загрузки context.js, который читает конфигурацию.
// Значения — те, что заданы по умолчанию в .env.example: 5 попыток
// за 15 минут. Блокировку учётной записи отодвигаем, чтобы она не
// сработала раньше и не подменила проверяемый эффект.
process.env.LOGIN_RATE_MAX_ATTEMPTS = '5';
process.env.LOGIN_RATE_WINDOW_MS = String(15 * 60 * 1000);
process.env.LOGIN_LOCKOUT_THRESHOLD = '1000';

const ctx = require('./helpers/context');

describe('ограничение частоты входа', () => {
  before(async () => {
    ctx.resetDb();
    await ctx.createUser({ username: 'target', role: 'user' });
  });

  it('после 5 неудачных попыток отвечает 429, а не проверяет пароль', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await ctx.request(ctx.app)
        .post('/api/login')
        .send({ username: 'target', password: 'wrong-password' });

      assert.equal(res.status, 401, `попытка ${attempt} должна дойти до проверки пароля`);
    }

    const blocked = await ctx.request(ctx.app)
      .post('/api/login')
      .send({ username: 'target', password: 'wrong-password' });

    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, 'too_many_attempts');
    assert.ok(blocked.body.retry_after_seconds > 0);
  });

  it('лимит закрывает вход и с верным паролем — счётчик по адресу, не по паролю', async () => {
    const res = await ctx.request(ctx.app)
      .post('/api/login')
      .send({ username: 'target', password: ctx.DEFAULT_PASSWORD });

    assert.equal(res.status, 429);
  });
});
