'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, describe, it } = require('node:test');

const ctx = require('./helpers/context');
const keys = require('./helpers/keys');

const config = require('../src/config');
const configStore = require('../src/ssh/configStore');
const { WEB_ROOT } = require('../src/routes/pages');

/**
 * Приватный ключ и файлы с секретами не должны быть достижимы ни по HTTP,
 * ни по правам файловой системы. Проверок «на глаз» здесь мало: раздача
 * статики — ровно то место, где одна невнимательная строка открывает
 * каталог целиком.
 */
describe('хранение секретов', () => {
  before(async () => {
    ctx.resetDb();
    await ctx.createUser({ username: 'admin', role: 'admin' });
    const { agent } = await ctx.loginAs('admin');
    const res = await agent.put('/api/admin/ssh-config').send({
      host: '10.0.0.9',
      port: 22,
      ssh_username: 'deploy',
      private_key: keys.generateEd25519OpenSsh(),
      passphrase: 'file-mode-check',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  describe('файловая система', () => {
    it('ключ лежит с правами 0600, каталог — 0700', () => {
      const keyPath = configStore.keyPath();

      assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600, 'ключ должен быть доступен только владельцу');
      assert.equal(
        fs.statSync(config.ssh.keysDir).mode & 0o777,
        0o700,
        'каталог с ключами должен быть закрыт целиком'
      );
    });

    it('ключ лежит вне каталога статики', () => {
      const keyPath = path.resolve(configStore.keyPath());
      const webRoot = path.resolve(WEB_ROOT);

      assert.equal(
        keyPath.startsWith(webRoot + path.sep),
        false,
        `ключ ${keyPath} оказался внутри раздаваемого каталога ${webRoot}`
      );
    });

    it('база данных тоже вне каталога статики', () => {
      const dbPath = path.resolve(config.db.path);
      assert.equal(dbPath.startsWith(path.resolve(WEB_ROOT) + path.sep), false);
    });

    it('passphrase на диске лежит только зашифрованной', () => {
      const row = ctx.getDb().prepare('SELECT passphrase_enc FROM ssh_config WHERE id = 1').get();

      assert.ok(Buffer.isBuffer(row.passphrase_enc));
      assert.equal(
        row.passphrase_enc.includes(Buffer.from('file-mode-check')),
        false,
        'passphrase не должна встречаться в хранимом виде'
      );
    });
  });

  describe('раздача по HTTP', () => {
    /*
     * Пути собраны из двух источников: очевидные имена, которые перебирает
     * любой сканер, и обходы каталога в разных кодировках — на них ломается
     * ровно та защита, которая проверяет строку пути, а не итоговый файл.
     */
    const FORBIDDEN = [
      '/.env',
      '/server/.env',
      '/env',
      '/keys/host_key',
      '/host_key',
      '/data/webssh.sqlite',
      '/webssh.sqlite',
      '/package.json',
      '/server/package.json',
      '/src/config.js',
      '/js/%2e%2e/%2e%2e/server/src/config.js',
      '/css/%2e%2e/%2e%2e/.env',
      '/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      '/vendor/%2e%2e/package.json',
      '/js/..%2f..%2fserver%2fsrc%2fconfig.js',
      '/.git/config',
      '/docker-compose.yml',
    ];

    it('секретные и служебные файлы не отдаются', async () => {
      for (const target of FORBIDDEN) {
        const res = await ctx.request(ctx.app).get(target);
        assert.notEqual(res.status, 200, `${target} не должен отдаваться (получено ${res.status})`);
      }
    });

    it('ни один ответ не содержит приватного ключа', async () => {
      for (const target of [...FORBIDDEN, '/login', '/css/base.css', '/js/admin/main.js']) {
        const res = await ctx.request(ctx.app).get(target);
        const body = res.text || '';
        assert.equal(body.includes('PRIVATE KEY'), false, `${target} вернул приватный ключ`);
        assert.equal(body.includes('file-mode-check'), false, `${target} вернул passphrase`);
      }
    });

    it('администратору ключ тоже не отдаётся — только отпечаток', async () => {
      const { agent } = await ctx.loginAs('admin');
      const res = await agent.get('/api/admin/ssh-config');

      assert.equal(res.status, 200);
      assert.equal('private_key' in res.body.ssh_config, false);
      assert.equal('passphrase' in res.body.ssh_config, false);
      assert.equal('private_key_path' in res.body.ssh_config, false);
      assert.match(res.body.ssh_config.private_key_fingerprint, /^SHA256:/);
      assert.equal(res.body.ssh_config.has_passphrase, true);
    });
  });
});
