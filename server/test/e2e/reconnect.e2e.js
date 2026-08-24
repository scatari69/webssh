/*
 * Симптом из отчёта: «в админке Connected — а терминал бесконечно
 * reconnecting». Проверяем в настоящем браузере, что цикл прекратился.
 */
process.chdir(require('node:path').resolve(__dirname, '..', '..'));

const { freePort, requirePlaywright, run } = require('./harness');

const { chromium } = requirePlaywright();

run('терминал: постоянные ошибки SSH не переподключаются', async (report) => {
  const check = (label, ok, extra) => report.check(label, ok, extra);

  const APP_PORT = await freePort();
  process.env.PUBLIC_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

  const ctx = require('../helpers/context');
  const wsClient = require('../helpers/wsClient');
  const sshd = require('../helpers/sshd');

  // Хост пускает по ключу, но терминала не даёт.
  const host = await sshd.start({ extraConfig: ['PermitTTY no'] });
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

  const probe = await agent.post('/api/admin/ssh-config/test').send({});
  check('админская проба говорит «подключение удалось»', probe.body.ok === true, JSON.stringify(probe.body));

  const browser = await chromium.launch();
  const errors = [];
  const context = await browser.newContext({ locale: 'ru-RU' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));

  // Считаем, сколько раз страница пытается открыть сокет.
  let attempts = 0;
  page.on('websocket', () => {
    attempts += 1;
  });

  await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.fill('#username', 'operator');
  await page.fill('#password', ctx.DEFAULT_PASSWORD);
  await page.click('#submit-credentials');
  await page.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });

  // Ждём, пока страница отреагирует на отказ.
  await page.waitForFunction(() => document.getElementById('status')?.dataset.state === 'error', {
    timeout: 20000,
  });

  const afterFirst = attempts;
  const statusText = (await page.textContent('#status')).trim();
  const overlay = (await page.textContent('#overlay')).replace(/\s+/g, ' ').trim();

  check('состояние — ошибка, а не «переподключение»', true, statusText);
  check(
    'человеку сказано про PTY, а не «пробуем ещё раз»',
    /PTY|терминал/i.test(overlay) && !/через \d+ с/i.test(overlay),
    overlay.slice(0, 160)
  );

  // Главное: цикла нет. Ждём заведомо дольше первой задержки (1 с) и
  // проверяем, что новых попыток не появилось.
  await page.waitForTimeout(6000);
  check(
    'новых попыток подключения нет',
    attempts === afterFirst,
    `было ${afterFirst}, стало ${attempts}`
  );
  check('всего попыток ровно одна', attempts === 1, String(attempts));

  check('нет ошибок JavaScript', errors.length === 0, errors.join('; '));

  await browser.close();
  await server.close();
  await host.stop();
  require('../../src/ssh/manager').closeAll();
  require('../../src/ssh/manager').stopIdleSweeper();

});
