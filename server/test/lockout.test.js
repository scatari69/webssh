'use strict';

const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

// Блокировка учётной записи проверяется в отрыве от лимита по IP: лимит
// поднят так, чтобы не сработать первым и не подменить проверяемый эффект.
process.env.LOGIN_LOCKOUT_THRESHOLD = '3';
process.env.LOGIN_RATE_MAX_ATTEMPTS = '1000';

const ctx = require('./helpers/context');

describe('блокировка учётной записи', () => {
  before(async () => {
    ctx.resetDb();
    await ctx.createUser({ username: 'victim', role: 'user' });
  });

  it('после серии неудач запирает учётку даже при верном пароле', async () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const res = await ctx.request(ctx.app)
        .post('/api/login')
        .send({ username: 'victim', password: 'wrong-password' });
      assert.equal(res.status, 401, `попытка ${attempt}`);
    }

    const locked = await ctx.request(ctx.app)
      .post('/api/login')
      .send({ username: 'victim', password: ctx.DEFAULT_PASSWORD });

    assert.equal(locked.status, 423);
    assert.equal(locked.body.error, 'account_locked');
    assert.ok(locked.body.retry_after_seconds > 0);

    assert.ok(
      ctx.auditActions().some((row) => row.action === 'auth.login' && /locked/.test(row.detail || '')),
      'блокировка должна быть видна в журнале'
    );
  });

  it('сброс пароля администратором снимает блокировку', async () => {
    const admin = await ctx.createUser({ username: 'admin', role: 'admin' });
    const { agent } = await ctx.loginAs(admin.username);

    const victim = ctx.getDb().prepare("SELECT id FROM users WHERE username = 'victim'").get();
    const reset = await agent
      .patch(`/api/admin/users/${victim.id}/password`)
      .send({ password: 'unlocked-password-1' });
    assert.equal(reset.status, 200);

    const res = await ctx.request(ctx.app)
      .post('/api/login')
      .send({ username: 'victim', password: 'unlocked-password-1' });

    assert.equal(res.status, 200);
  });
});
