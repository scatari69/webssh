'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const ctx = require('./helpers/context');
const sshd = require('./helpers/sshd');
const wsClient = require('./helpers/wsClient');

const sshdAvailable = sshd.isAvailable();
const skip = sshdAvailable ? false : 'sshd/ssh-keygen недоступны: настоящий SSH-хост не поднять';

describe('WebSocket-терминал', { skip }, () => {
  let server;
  let host;
  let operatorCookie;

  /** Настраивает ssh_config через админский API — как это делал бы человек. */
  async function configureHost(overrides = {}) {
    const { agent } = await ctx.loginAs('admin');
    const res = await agent.put('/api/admin/ssh-config').send({
      host: '127.0.0.1',
      port: host.port,
      ssh_username: host.username,
      private_key: host.privateKey,
      ...overrides,
    });
    assert.equal(res.status, 200, `настройка хоста не удалась: ${JSON.stringify(res.body)}`);
    return res.body.ssh_config;
  }

  async function loginOperator() {
    const res = await ctx
      .request(server.baseUrl)
      .post('/api/login')
      .send({ username: 'operator', password: ctx.DEFAULT_PASSWORD });
    assert.equal(res.status, 200);
    return wsClient.cookieFrom(res);
  }

  before(async () => {
    host = await sshd.start();
    server = await wsClient.startServer(ctx.app);
  });

  after(async () => {
    // Сессии закрываем явно: упавший тест мог оставить открытый сокет, и
    // тогда процесс не завершится.
    require('../src/ssh/manager').closeAll();
    require('../src/ssh/manager').stopIdleSweeper();
    if (server) await server.close();
    if (host) await host.stop();
  });

  describe('доступ', () => {
    before(async () => {
      ctx.resetDb();
      await ctx.createUser({ username: 'admin', role: 'admin' });
      await ctx.createUser({ username: 'operator', role: 'user' });
      await configureHost();
      operatorCookie = await loginOperator();
    });

    it('без cookie сессии соединение не устанавливается', async () => {
      const result = await wsClient.connect(server.wsUrl);

      assert.ok(result.rejected, 'ожидался отказ до рукопожатия');
      assert.equal(result.rejected.status, 401);
    });

    it('отклоняет чужой Origin', async () => {
      const result = await wsClient.connect(server.wsUrl, {
        cookie: operatorCookie,
        origin: 'https://evil.example.com',
      });

      assert.ok(result.rejected);
      assert.equal(result.rejected.status, 403);
    });

    it('пропускает со своим Origin', async () => {
      const { client } = await wsClient.connect(server.wsUrl, {
        cookie: operatorCookie,
        origin: 'http://localhost',
      });
      await client.waitForMessage('ready');
      client.close();
    });

    it('деактивация пользователя закрывает открытый терминал', async () => {
      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('ready');

      const target = ctx.getDb().prepare("SELECT id FROM users WHERE username = 'operator'").get();
      const { agent } = await ctx.loginAs('admin');
      const res = await agent.delete(`/api/admin/users/${target.id}`);

      assert.equal(res.body.terminals_closed, 1);
      await client.waitForClose();
      assert.equal(client.closed.code, 4403);

      // Возвращаем в строй для последующих наборов.
      await agent.patch(`/api/admin/users/${target.id}`).send({ is_active: true });
      operatorCookie = await loginOperator();
    });
  });

  describe('ненастроенный хост', () => {
    before(async () => {
      ctx.resetDb();
      await ctx.createUser({ username: 'operator', role: 'user' });
      operatorCookie = await loginOperator();
    });

    it('отдаёт понятную ошибку вместо попытки подключения', async () => {
      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });

      await client.waitForMessage('error');
      const error = client.message('error');

      assert.equal(error.error, 'ssh_not_configured');
      assert.match(error.message, /не настроен/i);

      await client.waitForClose();
      assert.equal(client.closed.code, 4404);
    });
  });

  describe('сквозная передача данных', () => {
    before(async () => {
      ctx.resetDb();
      await ctx.createUser({ username: 'admin', role: 'admin' });
      await ctx.createUser({ username: 'operator', role: 'user' });
      await configureHost();
      operatorCookie = await loginOperator();
    });

    it('выдаёт PTY и проводит команду до настоящего хоста и обратно', async () => {
      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });

      client.resize(100, 30);
      await client.waitForMessage('ready');

      client.write('echo PROOF-$((6*7))-OF-PTY\n');
      await client.waitForOutput('PROOF-42-OF-PTY');

      client.close();
      await client.waitForClose();
    });

    it('терминал именно интерактивный: TERM и признак tty на месте', async () => {
      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('ready');

      client.write('echo "TERM=[$TERM]"; tty | sed "s/^/TTY=/"\n');
      await client.waitForOutput('TERM=[xterm-256color]');
      await client.waitForOutput('TTY=/dev/pts/');

      client.close();
    });

    it('размеры окна доходят до хоста и меняются на лету', async () => {
      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });

      client.resize(120, 40);
      await client.waitForMessage('ready');

      client.write('stty size\n');
      await client.waitForOutput('40 120');

      client.resize(90, 25);
      // Небольшая пауза: setWindow идёт отдельным запросом по каналу.
      await new Promise((resolve) => setTimeout(resolve, 300));
      client.write('stty size\n');
      await client.waitForOutput('25 90');

      client.close();
    });

    it('переносит вывод, не разрушая многобайтовые символы', async () => {
      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('ready');

      // Длинная строка из трёхбайтовых символов гарантированно разрежется
      // на границе порции; при передаче байтами это безразлично.
      // Маркер конца склеивается из двух кусков: PTY отражает набранную
      // команду, и цельный маркер в эхе сработал бы раньше, чем придёт
      // собственно вывод.
      client.write(
        'printf "НАЧАЛО"; i=0; while [ $i -lt 400 ]; do printf "──────────"; i=$((i+1)); done; printf " КО""НЕЦ\\n"\n'
      );
      await client.waitForOutput('КОНЕЦ');
      await client.waitFor((c) => (c.text.match(/─/g) || []).length >= 4000, {
        label: 'полного длинного вывода',
      });

      /*
       * Проверяется вывод программы, а не эхо набранной команды.
       *
       * Эхо рисует readline на удалённом хосте, и при переносе строки на
       * границе окна он вставляет возврат каретки посреди трёхбайтового
       * символа, оставляя осиротевший байт. Это поведение удалённой
       * стороны: тот же байт на том же смещении приходит и через голый
       * ssh2, без участия здешнего кода. Прокси обязан донести байты как
       * есть — включая чужие странности, — а не «чинить» их.
       */
      const text = client.text;
      const start = text.lastIndexOf('НАЧАЛО');
      const end = text.indexOf('КОНЕЦ', start);
      assert.ok(start >= 0 && end > start, 'не нашли область вывода программы');

      const programOutput = text.slice(start, end);
      assert.equal(
        programOutput.includes('�'),
        false,
        'в выводе программы появился символ замены — байты испорчены'
      );
      // 4000 символов по 3 байта — заведомо больше одной порции чтения.
      const dashes = (programOutput.match(/─/g) || []).length;
      assert.equal(dashes, 4000, `символов получено: ${dashes}`);

      client.close();
    });

    it('сообщает о завершении шелла и закрывает соединение', async () => {
      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('ready');

      client.write('exit 3\n');

      await client.waitForMessage('exit');
      assert.equal(client.message('exit').code, 3);

      await client.waitForClose();
    });

    it('пишет в журнал открытие и закрытие, но не содержимое', async () => {
      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('ready');

      client.write('echo SECRET-CONTENT-MARKER\n');
      await client.waitForOutput('SECRET-CONTENT-MARKER');

      client.close();
      await client.waitForClose();
      await new Promise((resolve) => setTimeout(resolve, 300));

      const rows = ctx.auditActions();
      const open = rows.find((r) => r.action === 'terminal.open');
      const close = rows.find((r) => r.action === 'terminal.close');

      assert.ok(open, 'нет записи terminal.open');
      assert.ok(close, 'нет записи terminal.close');
      assert.match(close.detail, /bytes_in/);
      assert.match(close.detail, /duration_ms/);

      // Содержимое терминала в журнал попадать не должно: там пароли,
      // которые человек набирает в приглашениях sudo.
      assert.equal(JSON.stringify(rows).includes('SECRET-CONTENT-MARKER'), false);
    });

    it('отвечает на ping и отвергает мусор', async () => {
      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('ready');

      client.send({ type: 'ping' });
      await client.waitForMessage('pong');

      client.ws.send('это не json');
      await client.waitForMessage('error');
      assert.equal(client.message('error').error, 'invalid_json');

      client.send({ type: 'resize', cols: 0, rows: 5000 });
      await client.waitFor((c) => c.messages.filter((m) => m.type === 'error').length >= 2, {
        label: 'второй ошибки',
      });

      client.close();
    });
  });

  describe('ключ хоста', () => {
    before(async () => {
      ctx.resetDb();
      await ctx.createUser({ username: 'admin', role: 'admin' });
      await ctx.createUser({ username: 'operator', role: 'user' });
      await configureHost();
      operatorCookie = await loginOperator();
    });

    it('запоминается при первом подключении (TOFU)', async () => {
      const before = ctx.getDb().prepare('SELECT known_host_key FROM ssh_config WHERE id = 1').get();
      assert.equal(before.known_host_key, null);

      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('ready');
      client.close();

      const after = ctx.getDb().prepare('SELECT known_host_fingerprint FROM ssh_config WHERE id = 1').get();
      assert.equal(after.known_host_fingerprint, host.hostKeyFingerprint);
      assert.ok(ctx.auditActions().some((r) => r.action === 'ssh_config.host_key_learned'));
    });

    it('несовпадение с запомненным обрывает подключение', async () => {
      const { client: first } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await first.waitForMessage('ready');
      first.close();

      // Подменяем запомненный ключ — как если бы на том же адресе оказался
      // другой сервер.
      const foreign = require('node:crypto').randomBytes(51).toString('base64');
      ctx.getDb().prepare('UPDATE ssh_config SET known_host_key = ? WHERE id = 1').run(foreign);

      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('error');

      assert.equal(client.message('error').error, 'ssh_host_key_mismatch');
      await client.waitForClose();
      assert.equal(client.closed.code, 4410);
      assert.ok(ctx.auditActions().some((r) => r.action === 'ssh_config.host_key_mismatch'));
    });
  });

  describe('ошибки подключения', () => {
    before(async () => {
      ctx.resetDb();
      await ctx.createUser({ username: 'admin', role: 'admin' });
      await ctx.createUser({ username: 'operator', role: 'user' });
    });

    it('закрытый порт — понятная причина, а не молчание', async () => {
      await configureHost({ port: 1 });
      operatorCookie = await loginOperator();

      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('error');

      const error = client.message('error');
      assert.ok(['ssh_connection_refused', 'ssh_host_unreachable'].includes(error.error), error.error);
      assert.ok(error.message.length > 0);

      await client.waitForClose();
      assert.equal(client.closed.code, 4500);
    });

    it('неподходящий ключ — отказ аутентификации', async () => {
      const { execFileSync } = require('node:child_process');
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-wrongkey-'));
      const keyFile = path.join(dir, 'wrong');
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyFile, '-N', '', '-q']);

      await configureHost({ private_key: fs.readFileSync(keyFile, 'utf8') });
      fs.rmSync(dir, { recursive: true, force: true });
      operatorCookie = await loginOperator();

      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('error');

      assert.equal(client.message('error').error, 'ssh_auth_failed');
      assert.match(client.message('error').message, /ключ/i);

      await client.waitForClose();
    });
  });

  describe('лимиты', () => {
    before(async () => {
      ctx.resetDb();
      await ctx.createUser({ username: 'admin', role: 'admin' });
      await ctx.createUser({ username: 'operator', role: 'user' });
      await configureHost();
      operatorCookie = await loginOperator();
    });

    it('больше MAX_SESSIONS_PER_USER одновременных сессий не открывается', async () => {
      const limit = require('../src/config').limits.maxSessionsPerUser;
      const opened = [];

      for (let i = 0; i < limit; i += 1) {
        const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
        await client.waitForMessage('ready');
        opened.push(client);
      }

      const { client: extra } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await extra.waitForMessage('error');

      assert.equal(extra.message('error').error, 'session_limit_user');
      await extra.waitForClose();
      assert.equal(extra.closed.code, 4409);

      for (const client of opened) client.close();
      await Promise.all(opened.map((client) => client.waitForClose()));
    });

    it('кадр сверх предела рвёт соединение, а не съедает память', async () => {
      const limit = require('../src/config').limits.wsMaxMessageBytes;
      const { client } = await wsClient.connect(server.wsUrl, { cookie: operatorCookie });
      await client.waitForMessage('ready');

      // Вдвое больше предела: ws отбрасывает такой кадр, не дочитывая его.
      client.write('x'.repeat(limit * 2));

      await client.waitForClose();
      assert.ok(
        client.closed.code === 4413 || client.closed.code === 1009,
        `ожидалось закрытие по превышению предела, получено ${client.closed.code}`
      );

      // Причина должна остаться в журнале: без неё обрыв неотличим от
      // обычного закрытия вкладки.
      const reasons = ctx
        .getDb()
        .prepare("SELECT detail FROM audit_log WHERE action = 'terminal.close' ORDER BY id DESC LIMIT 1")
        .get();
      assert.match(reasons.detail, /message_too_large/);
    });
  });
});
