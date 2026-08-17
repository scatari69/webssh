'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { beforeEach, describe, it } = require('node:test');

const ctx = require('./helpers/context');
const keys = require('./helpers/keys');

const BASE = { host: 'ssh.example.com', port: 2222, ssh_username: 'deploy' };

describe('админ API: конфигурация SSH-хоста', () => {
  let adminAgent;

  beforeEach(async () => {
    ctx.resetDb();
    await ctx.createUser({ username: 'admin', role: 'admin' });
    await ctx.createUser({ username: 'member', role: 'user' });
    ({ agent: adminAgent } = await ctx.loginAs('admin'));
  });

  describe('доступ', () => {
    it('обычному пользователю закрыт', async () => {
      const { agent } = await ctx.loginAs('member');
      assert.equal((await agent.get('/api/admin/ssh-config')).status, 403);
      assert.equal((await agent.put('/api/admin/ssh-config').send(BASE)).status, 403);
    });
  });

  describe('чтение', () => {
    it('до настройки сообщает, что конфигурация не готова', async () => {
      const res = await adminAgent.get('/api/admin/ssh-config');

      assert.equal(res.status, 200);
      assert.equal(res.body.ssh_config.is_configured, false);
      assert.equal(res.body.ssh_config.has_private_key, false);
    });

    it('никогда не отдаёт приватный ключ и passphrase', async () => {
      const privateKey = keys.generateEd25519OpenSsh();
      await adminAgent.put('/api/admin/ssh-config').send({ ...BASE, private_key: privateKey, passphrase: 'sekret' });

      const res = await adminAgent.get('/api/admin/ssh-config');
      const dump = JSON.stringify(res.body);

      assert.equal(dump.includes('PRIVATE KEY'), false);
      assert.equal(dump.includes('sekret'), false);
      assert.equal('private_key' in res.body.ssh_config, false);
      assert.equal('passphrase' in res.body.ssh_config, false);
      // Вместо них — безопасные признаки.
      assert.equal(res.body.ssh_config.has_private_key, true);
      assert.equal(res.body.ssh_config.has_passphrase, true);
      assert.match(res.body.ssh_config.private_key_fingerprint, /^SHA256:/);
    });
  });

  describe('обновление', () => {
    it('сохраняет ed25519 в формате OpenSSH и считает отпечаток', async () => {
      const res = await adminAgent
        .put('/api/admin/ssh-config')
        .send({ ...BASE, private_key: keys.generateEd25519OpenSsh() });

      assert.equal(res.status, 200);
      assert.equal(res.body.ssh_config.private_key_type, 'ssh-ed25519');
      assert.match(res.body.ssh_config.private_key_fingerprint, /^SHA256:/);
      assert.equal(res.body.ssh_config.is_configured, true);
      assert.equal(JSON.stringify(res.body).includes('PRIVATE KEY'), false);
    });

    it('сохраняет RSA в формате PEM', async () => {
      const res = await adminAgent
        .put('/api/admin/ssh-config')
        .send({ ...BASE, private_key: keys.generateRsaPem() });

      assert.equal(res.status, 200);
      assert.equal(res.body.ssh_config.private_key_type, 'ssh-rsa');
    });

    it('кладёт ключ в SSH_KEYS_DIR с правами 0600', async () => {
      await adminAgent.put('/api/admin/ssh-config').send({ ...BASE, private_key: keys.generateEd25519OpenSsh() });

      const keyPath = require('../src/ssh/configStore').keyPath();
      const stat = fs.statSync(keyPath);

      assert.equal(stat.mode & 0o777, 0o600);
      assert.match(fs.readFileSync(keyPath, 'utf8'), /BEGIN OPENSSH PRIVATE KEY/);
    });

    it('хранит passphrase только в зашифрованном виде', async () => {
      await adminAgent
        .put('/api/admin/ssh-config')
        .send({ ...BASE, private_key: keys.generateEd25519OpenSsh(), passphrase: 'plaintext-passphrase' });

      const row = ctx.getDb().prepare('SELECT passphrase_enc FROM ssh_config WHERE id = 1').get();

      assert.ok(Buffer.isBuffer(row.passphrase_enc));
      assert.equal(row.passphrase_enc.includes(Buffer.from('plaintext-passphrase')), false);
      // Первый байт — версия формата, второй — идентификатор ключа шифрования.
      assert.equal(row.passphrase_enc[0], 1);

      const secretbox = require('../src/crypto/secretbox');
      const configStore = require('../src/ssh/configStore');
      assert.equal(
        secretbox.openString(row.passphrase_enc, configStore.PASSPHRASE_CONTEXT),
        'plaintext-passphrase'
      );
    });

    it('не пишет ключ и passphrase в журнал', async () => {
      const privateKey = keys.generateEd25519OpenSsh();
      await adminAgent
        .put('/api/admin/ssh-config')
        .send({ ...BASE, private_key: privateKey, passphrase: 'do-not-log-me' });

      const dump = JSON.stringify(ctx.auditActions());

      assert.equal(dump.includes('do-not-log-me'), false);
      assert.equal(dump.includes('PRIVATE KEY'), false);
      // При этом факт замены ключа и его отпечаток остаются видимы.
      assert.ok(ctx.auditActions().some((row) => row.action === 'ssh_config.key_replaced'));
      assert.match(dump, /SHA256:/);
    });

    it('сохраняет прежний ключ, если поле не передано', async () => {
      const first = await adminAgent
        .put('/api/admin/ssh-config')
        .send({ ...BASE, private_key: keys.generateEd25519OpenSsh() });
      const fingerprint = first.body.ssh_config.private_key_fingerprint;

      const second = await adminAgent
        .put('/api/admin/ssh-config')
        .send({ host: 'other.example.com', port: 22, ssh_username: 'ops' });

      assert.equal(second.status, 200);
      assert.equal(second.body.ssh_config.private_key_fingerprint, fingerprint);
      assert.equal(second.body.ssh_config.host, 'other.example.com');
    });

    it('убирает passphrase по явному null', async () => {
      await adminAgent
        .put('/api/admin/ssh-config')
        .send({ ...BASE, private_key: keys.generateEd25519OpenSsh(), passphrase: 'sekret' });

      const res = await adminAgent.put('/api/admin/ssh-config').send({ ...BASE, passphrase: null });

      assert.equal(res.status, 200);
      assert.equal(res.body.ssh_config.has_passphrase, false);
    });

    it('отклоняет мусор вместо ключа', async () => {
      const res = await adminAgent
        .put('/api/admin/ssh-config')
        .send({ ...BASE, private_key: 'это совершенно точно не ключ' });

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'private_key_invalid');
    });

    it('отклоняет неподдерживаемый формат PKCS#8', async () => {
      const crypto = require('node:crypto');
      const pkcs8 = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey;

      const res = await adminAgent.put('/api/admin/ssh-config').send({ ...BASE, private_key: pkcs8 });

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'private_key_invalid');
    });

    it('проверяет host, port и ssh_username', async () => {
      const cases = [
        [{ ...BASE, host: 'ssh example.com; rm -rf /' }, 'host_invalid'],
        [{ ...BASE, host: '' }, 'host_invalid'],
        [{ ...BASE, port: 0 }, 'port_invalid'],
        [{ ...BASE, port: 70000 }, 'port_invalid'],
        [{ ...BASE, port: 'twenty two' }, 'port_invalid'],
        [{ ...BASE, ssh_username: 'ops user' }, 'ssh_username_invalid'],
        [{ ...BASE, ssh_username: '' }, 'ssh_username_invalid'],
      ];

      for (const [payload, expected] of cases) {
        const res = await adminAgent.put('/api/admin/ssh-config').send(payload);
        assert.equal(res.status, 400, `ожидался 400 для ${JSON.stringify(payload)}`);
        assert.equal(res.body.error, expected);
      }
    });

    it('фиксирует в журнале неудачную попытку обновления', async () => {
      await adminAgent.put('/api/admin/ssh-config').send({ ...BASE, host: 'нельзя так' });

      const failure = ctx.auditActions().find((row) => row.outcome === 'failure');
      assert.ok(failure);
      assert.equal(failure.action, 'ssh_config.updated');
      assert.match(failure.detail, /host_invalid/);
    });
  });

  describe('зашифрованные ключи', () => {
    const available = keys.sshKeygenAvailable();

    it(
      'принимает зашифрованный ключ с верной passphrase и отвергает с неверной',
      { skip: available ? false : 'ssh-keygen недоступен: зашифрованный ключ не собрать' },
      async () => {
        const encrypted = keys.generateEncryptedEd25519('right-passphrase');

        const noPass = await adminAgent
          .put('/api/admin/ssh-config')
          .send({ ...BASE, private_key: encrypted });
        assert.equal(noPass.status, 400);
        assert.equal(noPass.body.error, 'passphrase_required');

        const wrongPass = await adminAgent
          .put('/api/admin/ssh-config')
          .send({ ...BASE, private_key: encrypted, passphrase: 'wrong-passphrase' });
        assert.equal(wrongPass.status, 400);
        assert.equal(wrongPass.body.error, 'passphrase_invalid');

        const ok = await adminAgent
          .put('/api/admin/ssh-config')
          .send({ ...BASE, private_key: encrypted, passphrase: 'right-passphrase' });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.ssh_config.private_key_type, 'ssh-ed25519');
        assert.equal(ok.body.ssh_config.has_passphrase, true);
      }
    );

    it(
      'не даёт сменить passphrase на неподходящую для уже сохранённого ключа',
      { skip: available ? false : 'ssh-keygen недоступен: зашифрованный ключ не собрать' },
      async () => {
        const encrypted = keys.generateEncryptedEd25519('right-passphrase');
        await adminAgent
          .put('/api/admin/ssh-config')
          .send({ ...BASE, private_key: encrypted, passphrase: 'right-passphrase' });

        // Ключ не передаём — меняем только passphrase. Проверка должна
        // выполниться против уже лежащего на диске ключа, иначе поломка
        // всплыла бы лишь при первом SSH-подключении.
        const res = await adminAgent.put('/api/admin/ssh-config').send({ ...BASE, passphrase: 'nonsense' });

        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'passphrase_invalid');
      }
    );
  });
});
