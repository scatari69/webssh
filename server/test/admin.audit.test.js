'use strict';

const assert = require('node:assert/strict');
const { beforeEach, describe, it } = require('node:test');

const ctx = require('./helpers/context');
const keys = require('./helpers/keys');

describe('журнал действий', () => {
  let admin;

  beforeEach(async () => {
    ctx.resetDb();
    await ctx.createUser({ username: 'admin', role: 'admin' });
    await ctx.createUser({ username: 'member', role: 'user' });
    ({ agent: admin } = await ctx.loginAs('admin'));
  });

  it('закрыт для гостя и для обычного пользователя', async () => {
    const guest = await ctx.request(ctx.app).get('/api/admin/audit');
    assert.equal(guest.status, 401);

    const { agent: member } = await ctx.loginAs('member');
    const denied = await member.get('/api/admin/audit');
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'forbidden');
  });

  it('отдаёт записи новыми вперёд и разбирает detail', async () => {
    await admin.post('/api/admin/users').send({ username: 'newcomer', role: 'user' });

    const res = await admin.get('/api/admin/audit');

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.entries));
    assert.equal(res.body.entries[0].action, 'user.created');

    // Порядок — от новых к старым: страница показывает последнее сверху.
    const ids = res.body.entries.map((entry) => entry.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));

    // detail приходит объектом, а не строкой JSON.
    assert.equal(typeof res.body.entries[0].detail, 'object');
    assert.equal(res.body.entries[0].detail.username, 'newcomer');
    assert.equal(res.body.entries[0].actor_username, 'admin');
  });

  it('считает общее число записей отдельно от показанных', async () => {
    const res = await admin.get('/api/admin/audit?limit=1');

    assert.equal(res.body.entries.length, 1);
    assert.equal(res.body.limit, 1);
    assert.ok(res.body.total > 1, 'записей в журнале больше, чем показано');
  });

  it('листает по offset', async () => {
    const first = await admin.get('/api/admin/audit?limit=1');
    const second = await admin.get('/api/admin/audit?limit=1&offset=1');

    assert.notEqual(first.body.entries[0].id, second.body.entries[0].id);
    assert.ok(first.body.entries[0].id > second.body.entries[0].id);
  });

  it('не выдаёт больше потолка и переживает мусор в параметрах', async () => {
    const huge = await admin.get('/api/admin/audit?limit=100000');
    assert.equal(huge.status, 200);
    assert.equal(huge.body.limit, 500);

    for (const query of ['?limit=abc', '?limit=-5', '?offset=-1', '?limit=1&limit=2', '?limit=']) {
      const res = await admin.get(`/api/admin/audit${query}`);
      assert.equal(res.status, 200, query);
      assert.ok(res.body.limit >= 1 && res.body.limit <= 500, query);
      assert.ok(res.body.offset >= 0, query);
    }
  });

  it('не отдаёт секреты: passphrase и приватный ключ вычищены', async () => {
    const update = await admin.put('/api/admin/ssh-config').send({
      host: '10.0.0.5',
      port: 22,
      ssh_username: 'deploy',
      private_key: keys.generateEd25519OpenSsh(),
      passphrase: 'secret-passphrase',
    });
    assert.equal(update.status, 200);

    const res = await admin.get('/api/admin/audit');
    const dump = JSON.stringify(res.body);

    assert.equal(dump.includes('secret-passphrase'), false, 'passphrase не должна попадать в журнал');
    assert.equal(dump.includes('PRIVATE KEY'), false, 'приватный ключ не должен попадать в журнал');

    // При этом отпечаток остаётся: по нему видно, что ключ действительно сменился.
    const entry = res.body.entries.find((item) => item.action === 'ssh_config.key_replaced');
    assert.ok(entry, 'замена ключа должна быть в журнале');
    assert.match(entry.detail.private_key_fingerprint, /^SHA256:/);
  });

  it('просмотр журнала сам в журнал не пишется', async () => {
    const before = (await admin.get('/api/admin/audit')).body.total;
    await admin.get('/api/admin/audit');
    const after = (await admin.get('/api/admin/audit')).body.total;

    assert.equal(after, before);
  });
});
