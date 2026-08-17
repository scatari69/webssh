'use strict';

const assert = require('node:assert/strict');
const { beforeEach, describe, it } = require('node:test');

const ctx = require('./helpers/context');

/**
 * Код следующего 30-секундного шага. Он попадает в допуск на дрейф часов,
 * но его номер выше уже использованного, поэтому проходит проверку на
 * повтор — ровно как если бы человек дождался смены кода на экране.
 */
function nextCode(secret) {
  return ctx.totp.generateToken(secret, Math.floor(Date.now() / 1000) + 30);
}

function currentCode(secret) {
  return ctx.totp.generateToken(secret);
}

describe('TOTP', () => {
  beforeEach(() => ctx.resetDb());

  describe('обязательность', () => {
    it('администратора при первом входе отправляет на привязку', async () => {
      await ctx.createUser({ username: 'admin', role: 'admin' });

      const agent = ctx.request.agent(ctx.app);
      const res = await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });

      assert.equal(res.status, 200);
      assert.equal(res.body.mfa.required, true);
      assert.equal(res.body.mfa.enrolled, false);
      // Полноценной сессии ещё нет — только пароль принят.
      assert.equal(res.body.user, undefined);
    });

    it('обычного пользователя пускает без второго фактора', async () => {
      await ctx.createUser({ username: 'member', role: 'user' });

      const { res } = await ctx.loginAs('member');

      assert.equal(res.status, 200);
      assert.equal(res.body.mfa.required, false);
      assert.equal(res.body.user.username, 'member');
    });
  });

  describe('промежуточная сессия', () => {
    let agent;

    beforeEach(async () => {
      await ctx.createUser({ username: 'admin', role: 'admin' });
      agent = ctx.request.agent(ctx.app);
      await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });
    });

    it('не даёт доступа к API', async () => {
      assert.equal((await agent.get('/api/me')).status, 401);
      assert.equal((await agent.get('/api/admin/users')).status, 401);
      assert.equal((await agent.get('/api/admin/ssh-config')).status, 401);
    });

    it('протухает и перестаёт годиться для привязки', async () => {
      // Отматываем отметку времени в сохранённой сессии назад.
      ctx.getDb().exec("UPDATE sessions SET sess = json_set(sess, '$.pendingMfa.since', 0)");

      const res = await agent.post('/api/totp/enroll').send({});

      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'mfa_challenge_expired');
    });
  });

  describe('привязка', () => {
    let agent;

    beforeEach(async () => {
      await ctx.createUser({ username: 'admin', role: 'admin' });
      agent = ctx.request.agent(ctx.app);
      await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });
    });

    it('выдаёт секрет и ссылку для аутентификатора', async () => {
      const res = await agent.post('/api/totp/enroll').send({});

      assert.equal(res.status, 200);
      assert.match(res.body.secret, /^[A-Z2-7]{16,}$/);
      assert.match(res.body.otpauth_uri, /^otpauth:\/\/totp\//);
      assert.match(res.body.otpauth_uri, /issuer=webssh/);
    });

    it('не подтверждается неверным кодом и сессию не выдаёт', async () => {
      await agent.post('/api/totp/enroll').send({});

      const res = await agent.post('/api/totp/confirm').send({ code: '000000' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'totp_code_invalid');
      assert.equal((await agent.get('/api/me')).status, 401);
    });

    it('подтверждение завершает вход и выдаёт коды восстановления один раз', async () => {
      const enroll = await agent.post('/api/totp/enroll').send({});

      const res = await agent.post('/api/totp/confirm').send({ code: currentCode(enroll.body.secret) });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.totp_enabled, true);
      assert.equal(res.body.recovery_codes.length, 10);
      assert.match(res.body.recovery_codes[0], /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);

      // Сессия стала полноценной.
      const me = await agent.get('/api/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user.username, 'admin');

      // Второй раз коды не показываются.
      assert.equal(me.body.recovery_codes, undefined);
    });

    it('повторная привязка при включённом TOTP отклоняется', async () => {
      const { agent: full } = await ctx.loginAs('admin');

      const res = await full.post('/api/totp/enroll').send({});

      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'totp_already_enabled');
    });
  });

  describe('вход со вторым фактором', () => {
    let secret;

    beforeEach(async () => {
      await ctx.createUser({ username: 'admin', role: 'admin' });
      ({ secret } = await ctx.loginAs('admin'));
    });

    it('второй вход требует код и принимает верный', async () => {
      const agent = ctx.request.agent(ctx.app);
      const login = await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });

      assert.equal(login.body.mfa.required, true);
      assert.equal(login.body.mfa.enrolled, true);

      const res = await agent.post('/api/totp/verify').send({ code: nextCode(secret) });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.username, 'admin');
      assert.equal(res.body.used_recovery_code, false);
      assert.equal(res.body.recovery_codes_remaining, 10);
      assert.equal((await agent.get('/api/me')).status, 200);
    });

    it('отклоняет неверный код и не выдаёт сессию', async () => {
      const agent = ctx.request.agent(ctx.app);
      await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });

      const res = await agent.post('/api/totp/verify').send({ code: '000000' });

      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'totp_code_invalid');
      assert.equal((await agent.get('/api/me')).status, 401);
    });

    it('не принимает один и тот же код дважды', async () => {
      const code = nextCode(secret);

      const first = ctx.request.agent(ctx.app);
      await first.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });
      assert.equal((await first.post('/api/totp/verify').send({ code })).status, 200);

      // Тот же код внутри его окна действия — подсмотренный код не должен
      // работать второй раз.
      const second = ctx.request.agent(ctx.app);
      await second.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });
      const res = await second.post('/api/totp/verify').send({ code });

      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'totp_code_reused');
    });

    it('неудача второго фактора попадает в журнал как неудачный вход', async () => {
      const agent = ctx.request.agent(ctx.app);
      await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });
      await agent.post('/api/totp/verify').send({ code: '000000' });

      const failure = ctx.auditActions().find(
        (row) => row.action === 'auth.login' && row.outcome === 'failure'
      );

      assert.ok(failure);
      assert.match(failure.detail, /second_factor/);
    });
  });

  describe('коды восстановления', () => {
    let codes;

    beforeEach(async () => {
      await ctx.createUser({ username: 'admin', role: 'admin' });
      const { res } = await ctx.loginAs('admin');
      codes = res.body.recovery_codes;
    });

    it('пускают вместо кода из приложения и расходуются однократно', async () => {
      const agent = ctx.request.agent(ctx.app);
      await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });

      const res = await agent.post('/api/totp/verify').send({ code: codes[0] });

      assert.equal(res.status, 200);
      assert.equal(res.body.used_recovery_code, true);
      assert.equal(res.body.recovery_codes_remaining, 9);

      // Тот же код второй раз не работает.
      const again = ctx.request.agent(ctx.app);
      await again.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });
      const repeat = await again.post('/api/totp/verify').send({ code: codes[0] });

      assert.equal(repeat.status, 401);
      assert.equal(repeat.body.error, 'totp_code_invalid');
    });

    it('принимаются без учёта регистра и дефисов', async () => {
      const agent = ctx.request.agent(ctx.app);
      await agent.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });

      const mangled = codes[1].toLowerCase().replace(/-/g, ' ');
      const res = await agent.post('/api/totp/verify').send({ code: mangled });

      assert.equal(res.status, 200);
    });

    it('в базе лежат только хеши', async () => {
      const rows = ctx.getDb().prepare('SELECT code_hash FROM recovery_codes').all();

      assert.equal(rows.length, 10);
      for (const row of rows) {
        assert.match(row.code_hash, /^[0-9a-f]{64}$/);
        assert.equal(codes.some((c) => c.replace(/-/g, '') === row.code_hash), false);
      }
    });

    it('перевыпускаются по свежему коду и обесценивают прежние', async () => {
      const { agent, secret } = await ctx.loginAs('admin');

      const res = await agent.post('/api/totp/recovery-codes').send({ code: nextCode(secret) });

      assert.equal(res.status, 200);
      assert.equal(res.body.recovery_codes.length, 10);
      assert.equal(res.body.recovery_codes.includes(codes[0]), false);

      const stale = ctx.request.agent(ctx.app);
      await stale.post('/api/login').send({ username: 'admin', password: ctx.DEFAULT_PASSWORD });
      assert.equal((await stale.post('/api/totp/verify').send({ code: codes[0] })).status, 401);
    });
  });

  describe('добровольная привязка обычным пользователем', () => {
    it('включается, а затем требуется при входе', async () => {
      await ctx.createUser({ username: 'member', role: 'user' });
      const { agent } = await ctx.loginAs('member');

      const enroll = await agent.post('/api/totp/enroll').send({});
      assert.equal(enroll.status, 200);

      const confirm = await agent.post('/api/totp/confirm').send({ code: currentCode(enroll.body.secret) });
      assert.equal(confirm.status, 200);
      assert.equal(confirm.body.user.totp_enabled, true);

      const next = ctx.request.agent(ctx.app);
      const login = await next.post('/api/login').send({ username: 'member', password: ctx.DEFAULT_PASSWORD });

      assert.equal(login.body.mfa.required, true);
      assert.equal(login.body.mfa.enrolled, true);
    });

    it('отключается своим же кодом', async () => {
      await ctx.createUser({ username: 'member', role: 'user' });
      const { agent } = await ctx.loginAs('member');
      const enroll = await agent.post('/api/totp/enroll').send({});
      await agent.post('/api/totp/confirm').send({ code: currentCode(enroll.body.secret) });

      const res = await agent.delete('/api/totp').send({ code: nextCode(enroll.body.secret) });

      assert.equal(res.status, 200);
      assert.equal(res.body.user.totp_enabled, false);

      const next = ctx.request.agent(ctx.app);
      const login = await next.post('/api/login').send({ username: 'member', password: ctx.DEFAULT_PASSWORD });
      assert.equal(login.body.mfa.required, false);
    });

    it('не отключается без верного кода', async () => {
      await ctx.createUser({ username: 'member', role: 'user' });
      const { agent } = await ctx.loginAs('member');
      const enroll = await agent.post('/api/totp/enroll').send({});
      await agent.post('/api/totp/confirm').send({ code: currentCode(enroll.body.secret) });

      const res = await agent.delete('/api/totp').send({ code: '000000' });

      assert.equal(res.status, 401);
    });

    it('администратору отключить себе TOTP не даёт', async () => {
      await ctx.createUser({ username: 'admin', role: 'admin' });
      const { agent, secret } = await ctx.loginAs('admin');

      const res = await agent.delete('/api/totp').send({ code: nextCode(secret) });

      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'totp_required_for_role');
    });
  });

  describe('сброс администратором', () => {
    it('возвращает пользователя к привязке заново', async () => {
      await ctx.createUser({ username: 'admin', role: 'admin' });
      await ctx.createUser({ username: 'admin2', role: 'admin' });
      const { agent } = await ctx.loginAs('admin');

      const victim = ctx.getDb().prepare("SELECT id FROM users WHERE username = 'admin2'").get();

      // Привязываем второму администратору TOTP, затем сбрасываем.
      await ctx.loginAs('admin2');
      assert.equal(ctx.getDb().prepare('SELECT totp_enabled FROM users WHERE id = ?').get(victim.id).totp_enabled, 1);

      const res = await agent.delete(`/api/admin/users/${victim.id}/totp`);

      assert.equal(res.status, 200);
      assert.equal(res.body.user.totp_enabled, false);
      assert.equal(
        ctx.getDb().prepare('SELECT COUNT(*) AS c FROM recovery_codes WHERE user_id = ?').get(victim.id).c,
        0
      );

      const next = ctx.request.agent(ctx.app);
      const login = await next.post('/api/login').send({ username: 'admin2', password: ctx.DEFAULT_PASSWORD });
      assert.equal(login.body.mfa.enrolled, false);

      assert.ok(ctx.auditActions().some((row) => row.action === 'totp.reset_by_admin'));
    });

    it('обычному пользователю сброс чужого TOTP недоступен', async () => {
      await ctx.createUser({ username: 'admin', role: 'admin' });
      const target = await ctx.createUser({ username: 'member', role: 'user' });
      const { agent } = await ctx.loginAs('member');

      assert.equal((await agent.delete(`/api/admin/users/${target.id}/totp`)).status, 403);
    });
  });

  describe('хранение секрета', () => {
    it('в базе лежит зашифрованным и наружу не отдаётся', async () => {
      await ctx.createUser({ username: 'admin', role: 'admin' });
      const { agent, secret } = await ctx.loginAs('admin');

      const row = ctx.getDb().prepare("SELECT id, totp_secret_enc FROM users WHERE username = 'admin'").get();

      assert.ok(Buffer.isBuffer(row.totp_secret_enc));
      assert.equal(row.totp_secret_enc.includes(Buffer.from(secret)), false);
      assert.equal(row.totp_secret_enc[0], 1); // версия формата

      const secretbox = require('../src/crypto/secretbox');
      const totpService = require('../src/services/totp');
      assert.equal(secretbox.openString(row.totp_secret_enc, totpService.secretContext(row.id)), secret);

      // Ни один ответ API секрета не содержит.
      const me = await agent.get('/api/me');
      const list = await agent.get('/api/admin/users');
      for (const res of [me, list]) {
        const dump = JSON.stringify(res.body);
        assert.equal(dump.includes(secret), false);
        assert.equal(dump.includes('totp_secret'), false);
      }
    });

    it('секрет одного пользователя не расшифровывается в контексте другого', async () => {
      await ctx.createUser({ username: 'admin', role: 'admin' });
      await ctx.createUser({ username: 'admin2', role: 'admin' });
      await ctx.loginAs('admin');

      const row = ctx.getDb().prepare("SELECT id, totp_secret_enc FROM users WHERE username = 'admin'").get();
      const secretbox = require('../src/crypto/secretbox');
      const totpService = require('../src/services/totp');

      assert.throws(() => secretbox.openString(row.totp_secret_enc, totpService.secretContext(row.id + 1)));
    });
  });
});
