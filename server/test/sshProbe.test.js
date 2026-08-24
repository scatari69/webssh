'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const ctx = require('./helpers/context');
const keys = require('./helpers/keys');
const sshd = require('./helpers/sshd');

const skip = sshd.isAvailable() ? false : 'sshd/ssh-keygen недоступны: настоящий SSH-хост не поднять';

/**
 * Проба существует ровно ради одного вопроса: «почему у приложения не
 * подключается, если из консоли сервера подключается». Поэтому проверяются
 * не только успех, но и то, что каждая причина отличима от остальных.
 */
describe('проверка подключения к SSH-хосту', { skip }, () => {
  let host;
  let admin;

  before(async () => {
    host = await sshd.start();
  });

  after(async () => {
    if (host) await host.stop();
  });

  async function configure(overrides = {}) {
    const res = await admin.put('/api/admin/ssh-config').send({
      host: '127.0.0.1',
      port: host.port,
      ssh_username: host.username,
      private_key: host.privateKey,
      ...overrides,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.ssh_config;
  }

  async function freshAdmin() {
    ctx.resetDb();
    await ctx.createUser({ username: 'admin', role: 'admin' });
    await ctx.createUser({ username: 'member', role: 'user' });
    ({ agent: admin } = await ctx.loginAs('admin'));
  }

  it('на ненастроенном хосте говорит именно это', async () => {
    await freshAdmin();

    const res = await admin.post('/api/admin/ssh-config/test');

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'ssh_not_configured');
  });

  it('на рабочем хосте проходит и запоминает ключ хоста', async () => {
    await freshAdmin();
    await configure();

    const res = await admin.post('/api/admin/ssh-config/test');

    assert.equal(res.body.ok, true, JSON.stringify(res.body));
    assert.equal(res.body.learned, true, 'первое подключение должно запомнить ключ хоста');
    assert.match(res.body.fingerprint, /^SHA256:/);

    // Второй раз ключ уже известен — учить нечего.
    const again = await admin.post('/api/admin/ssh-config/test');
    assert.equal(again.body.ok, true);
    assert.equal(again.body.learned, false);
  });

  it('закрытый порт отличим от отвергнутого ключа', async () => {
    await freshAdmin();
    // Порт, на котором никто не слушает.
    await configure({ port: 1 });

    const refused = await admin.post('/api/admin/ssh-config/test');
    assert.equal(refused.body.ok, false);
    assert.ok(
      ['ssh_connection_refused', 'ssh_host_unreachable', 'ssh_timeout'].includes(refused.body.error),
      `неожиданная причина: ${refused.body.error}`
    );

    // Тот же хост, но чужой ключ.
    await freshAdmin();
    await configure({ private_key: keys.generateEd25519OpenSsh() });

    const rejected = await admin.post('/api/admin/ssh-config/test');
    assert.equal(rejected.body.ok, false);
    assert.equal(rejected.body.error, 'ssh_auth_failed');
  });

  it('неразрешимое имя отличимо от остальных причин', async () => {
    await freshAdmin();
    await configure({ host: 'this-host-does-not-exist.invalid' });

    const res = await admin.post('/api/admin/ssh-config/test');

    assert.equal(res.body.ok, false);
    assert.ok(
      ['ssh_host_unresolved', 'ssh_timeout'].includes(res.body.error),
      `неожиданная причина: ${res.body.error}`
    );
  });

  it('о петлевом адресе предупреждает отдельно: в контейнере он значит другое', async () => {
    await freshAdmin();
    await configure({ port: 1 });

    const res = await admin.post('/api/admin/ssh-config/test');

    assert.equal(res.body.ok, false);
    assert.equal(res.body.hint, 'loopback_in_container');

    // На обычном адресе подсказки быть не должно — она бы только сбивала.
    await freshAdmin();
    await configure({ host: '10.255.255.1', port: 22 });
    const other = await admin.post('/api/admin/ssh-config/test');
    assert.equal(other.body.ok, false);
    assert.equal(other.body.hint, null);
  });

  it('результат попадает в журнал', async () => {
    await freshAdmin();
    await configure();
    await admin.post('/api/admin/ssh-config/test');

    const entry = ctx.auditActions().find((a) => a.action === 'ssh_config.tested');
    assert.ok(entry, 'проба должна оставлять след в журнале');
    assert.equal(entry.outcome, 'success');
  });

  it('обычному пользователю проба недоступна', async () => {
    await freshAdmin();
    const { agent: member } = await ctx.loginAs('member');

    const res = await member.post('/api/admin/ssh-config/test');

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'forbidden');
  });

  it('без CSRF-токена проба не выполняется', async () => {
    await freshAdmin();

    const res = await admin.post('/api/admin/ssh-config/test').set('X-CSRF-Token', 'wrong-token');

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'csrf_token_invalid');
  });
});
