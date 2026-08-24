/*
 * Вторая причина того же симптома: PUBLIC_ORIGIN не совпадает с адресом
 * в браузере. Раньше браузер видел только 1006 и повторял вечно.
 */
process.chdir(require('node:path').resolve(__dirname, '..', '..'));

const { freePort, requirePlaywright, run } = require('./harness');

const { chromium } = requirePlaywright();

run('терминал: несовпадение Origin не уводит в цикл входов', async (report) => {
  const check = (label, ok, extra) => report.check(label, ok, extra);

  const APP_PORT = await freePort();
  // Настроено на один адрес, открывать будем по другому — типичная
  // ошибка при развёртывании за прокси.
  process.env.PUBLIC_ORIGIN = 'http://webssh.example.test';

  const ctx = require('../helpers/context');
  const wsClient = require('../helpers/wsClient');
  const sshd = require('../helpers/sshd');

  const host = await sshd.start();
  const server = await wsClient.startServer(ctx.app, APP_PORT);

  ctx.resetDb();
  await ctx.createUser({ username: 'admin', role: 'admin' });
  await ctx.createUser({ username: 'operator', role: 'user' });

  const { agent } = await ctx.loginAs('admin');
  const saved = await agent.put('/api/admin/ssh-config').send({
    host: '127.0.0.1',
    port: host.port,
    ssh_username: host.username,
    private_key: host.privateKey,
  });
  if (saved.status !== 200) throw new Error(JSON.stringify(saved.body));

  const browser = await chromium.launch();
  const errors = [];
  const context = await browser.newContext({ locale: 'ru-RU' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));

  let attempts = 0;
  page.on('websocket', () => {
    attempts += 1;
  });

  await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.fill('#username', 'operator');
  await page.fill('#password', ctx.DEFAULT_PASSWORD);
  await page.click('#submit-credentials');
  await page.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });

  await page.waitForFunction(() => document.getElementById('status')?.dataset.state === 'error', {
    timeout: 20000,
  });

  const overlay = (await page.textContent('#overlay')).replace(/\s+/g, ' ').trim();
  check('сказано про несовпадение адреса', /origin|адрес/i.test(overlay), overlay.slice(0, 180));

  const before = attempts;
  await page.waitForTimeout(6000);
  check('цикла переподключений нет', attempts === before, `было ${before}, стало ${attempts}`);

  // И, что важно для разбора чужой установки, отказ виден в журнале.
  const entry = ctx
    .getDb()
    .prepare("SELECT detail FROM audit_log WHERE action = 'terminal.rejected' ORDER BY id DESC LIMIT 1")
    .get();
  check('отказ записан в журнал', Boolean(entry) && /origin_not_allowed/.test(entry.detail), entry ? entry.detail.slice(0, 160) : 'нет записи');
  check('в журнале есть ожидаемый адрес', Boolean(entry) && /webssh\.example\.test/.test(entry.detail));

  check('нет ошибок JavaScript', errors.length === 0, errors.join('; '));

  await browser.close();
  await server.close();
  await host.stop();
  require('../../src/ssh/manager').closeAll();
  require('../../src/ssh/manager').stopIdleSweeper();

});
