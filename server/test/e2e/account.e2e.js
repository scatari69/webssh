/* Страница /account: обычный пользователь включает второй фактор сам. */
process.chdir(require('node:path').resolve(__dirname, '..', '..'));

const { freePort, requirePlaywright, run } = require('./harness');

const { chromium } = requirePlaywright();

run('страница /account: второй фактор своими руками', async (report) => {
  const check = (label, ok, extra) => report.check(label, ok, extra);

  const PORT = await freePort();
  process.env.PUBLIC_ORIGIN = `http://127.0.0.1:${PORT}`;

  const ctx = require('../helpers/context');
  const wsClient = require('../helpers/wsClient');
  const totp = require('../../src/auth/totp');
  const server = await wsClient.startServer(ctx.app, PORT);

  ctx.resetDb();
  await ctx.createUser({ username: 'admin', role: 'admin' });
  await ctx.createUser({ username: 'operator', role: 'user' });

  const browser = await chromium.launch();
  const c = await browser.newContext({ locale: 'ru-RU' });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  // Обычный пользователь: второй фактор доброволен, входит без него.
  await p.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await p.fill('#username', 'operator');
  await p.fill('#password', ctx.DEFAULT_PASSWORD);
  await p.click('#submit-credentials');
  await p.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });
  await p.waitForSelector('.xterm-screen', { timeout: 15000 });

  // Путь к странице из терминала — через контекстное меню.
  await p.click('#menu-btn');
  await p.waitForSelector('#context-menu:not([hidden])');
  const items = await p.locator('#context-menu .menu-item').allTextContents();
  check('в меню терминала есть путь к 2FA', items.some((t) => t.includes('Двухфакторная')), items.join(' | '));
  await p.locator('#context-menu .menu-item', { hasText: 'Двухфакторная' }).click();
  await p.waitForURL(`${server.baseUrl}/account`, { timeout: 10000 });

  check('страница открылась', (await p.textContent('.login-title')).includes('Двухфакторная'));
  check('показано, что фактор выключен', (await p.textContent('#state-notice')).includes('выключен'));
  check('кнопка включения видна', await p.locator('#enable').isVisible());
  check('управление скрыто, пока не включено', await p.locator('#manage-step').isHidden());

  // --- включение ---
  await p.click('#enable');
  await p.waitForSelector('#enroll-step:not(.hidden)');
  const secret = (await p.textContent('#enroll-secret')).trim();
  check('секрет выдан', /^[A-Z2-7]{16,}$/.test(secret), secret.slice(0, 12) + '…');
  check('ссылка otpauth ведёт в аутентификатор',
    (await p.getAttribute('#otpauth-link', 'href')).startsWith('otpauth://totp/'));

  await p.fill('#enroll-code', '000000');
  await p.click('#submit-enroll');
  await p.waitForSelector('#error:not(.hidden)');
  check('неверный код отклонён', (await p.textContent('#error')).includes('Неверный код'));

  await p.fill('#enroll-code', totp.generateToken(secret));
  await p.click('#submit-enroll');
  await p.waitForSelector('#recovery-step:not(.hidden)', { timeout: 10000 });
  const codes = await p.locator('#recovery-codes li').allTextContents();
  check('коды восстановления выданы', codes.length === 10, `${codes.length} шт.`);

  await p.click('#recovery-done');
  await p.waitForSelector('#state-step:not(.hidden)');
  check('состояние стало «включён»', (await p.textContent('#state-notice')).includes('включён'));
  check('видно, сколько кодов осталось', (await p.textContent('#state-detail')).includes('10'));

  // Второй фактор реально требуется при следующем входе.
  const relogin = await ctx.request(ctx.app).post('/api/login')
    .send({ username: 'operator', password: ctx.DEFAULT_PASSWORD });
  check('теперь вход требует второй фактор', relogin.body.mfa && relogin.body.mfa.required === true,
    JSON.stringify(relogin.body.mfa));

  // --- перевыпуск кодов ---
  ctx.getDb().prepare("UPDATE users SET totp_last_step = NULL WHERE username='operator'").run();
  await p.fill('#manage-code', totp.generateToken(secret));
  await p.click('#regenerate');
  await p.waitForSelector('#recovery-step:not(.hidden)', { timeout: 10000 });
  const fresh = await p.locator('#recovery-codes li').allTextContents();
  check('коды перевыпущены', fresh.length === 10 && fresh[0] !== codes[0]);
  await p.click('#recovery-done');
  await p.waitForSelector('#state-step:not(.hidden)');

  // --- отключение ---
  ctx.getDb().prepare("UPDATE users SET totp_last_step = NULL WHERE username='operator'").run();
  check('кнопка отключения доступна обычной роли', await p.locator('#disable').isVisible());
  await p.fill('#manage-code', totp.generateToken(secret));
  await p.click('#disable');
  await p.waitForFunction(
    () => document.getElementById('state-notice').textContent.includes('выключен'),
    null, { timeout: 10000 }
  );
  check('второй фактор отключён', true);

  const after = await ctx.request(ctx.app).post('/api/login')
    .send({ username: 'operator', password: ctx.DEFAULT_PASSWORD });
  check('вход снова без второго фактора', after.body.mfa && after.body.mfa.required === false);
  await c.close();

  // --- админ: обязательный фактор снять нельзя ---
  const ac = await browser.newContext({ locale: 'ru-RU' });
  const ap = await ac.newPage();
  ap.on('pageerror', (e) => errors.push('admin: ' + e.message));
  const { secret: adminSecret } = await ctx.loginAs('admin');

  await ap.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await ap.fill('#username', 'admin');
  await ap.fill('#password', ctx.DEFAULT_PASSWORD);
  await ap.click('#submit-credentials');
  await ap.waitForSelector('#verify-step:not(.hidden)', { timeout: 10000 });
  ctx.getDb().prepare("UPDATE users SET totp_last_step = NULL WHERE username='admin'").run();
  await ap.fill('#verify-code', totp.generateToken(adminSecret));
  await ap.click('#submit-verify');
  await ap.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });

  await ap.goto(`${server.baseUrl}/account`, { waitUntil: 'networkidle' });
  check('у админа фактор включён', (await ap.textContent('#state-notice')).includes('включён'));
  check('кнопки отключения у админа нет', await ap.locator('#disable').isHidden());
  check('перевыпуск кодов доступен', await ap.locator('#regenerate').isVisible());
  await ac.close();

  check('нет ошибок JavaScript', errors.length === 0, errors.join(' | '));

  await browser.close();
  require('../../src/ssh/manager').closeAll('account');
  await server.close();
});
