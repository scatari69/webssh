/*
 * Единственный администратор меняет пароль сам себе, оставив «сгенерировать».
 * Ожидание: он видит новый пароль и может им войти.
 */
process.chdir(require('node:path').resolve(__dirname, '..', '..'));

const { freePort, requirePlaywright, run } = require('./harness');

const { chromium } = requirePlaywright();

run('админка: единственный админ меняет пароль себе', async (report) => {
  const check = (label, ok, extra) => report.check(label, ok, extra);

  const APP_PORT = await freePort();
  process.env.PUBLIC_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

  const ctx = require('../helpers/context');
  const wsClient = require('../helpers/wsClient');
  const totp = require('../../src/auth/totp');

  const server = await wsClient.startServer(ctx.app, APP_PORT);

  // Ровно один администратор и никого больше — как у пользователя.
  ctx.resetDb();
  await ctx.createUser({ username: 'admin', role: 'admin' });
  const { secret } = await ctx.loginAs('admin');

  const browser = await chromium.launch();
  const c = await browser.newContext({ locale: 'ru-RU' });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await p.fill('#username', 'admin');
  await p.fill('#password', ctx.DEFAULT_PASSWORD);
  await p.click('#submit-credentials');
  await p.waitForSelector('#verify-step:not(.hidden)', { timeout: 10000 });
  ctx.getDb().prepare("UPDATE users SET totp_last_step = NULL WHERE username='admin'").run();
  await p.fill('#verify-code', totp.generateToken(secret));
  await p.click('#submit-verify');
  await p.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });

  await p.goto(`${server.baseUrl}/admin`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#users-table tr[data-username="admin"]');
  check('в системе один администратор', (await p.locator('#users-table tbody tr').count()) === 1);

  // --- сам сценарий ---
  await p.locator('#users-table tr[data-username="admin"]')
    .getByRole('button', { name: 'Сбросить пароль' })
    .click();
  await p.waitForSelector('#app-dialog[open]');

  const warn = (await p.textContent('#dialog-message')) || '';
  check('диалог предупреждает, что это своя учётка', /собственн|свою|разлогин|войти заново/i.test(warn), warn.slice(0, 110));

  check('«сгенерировать» включено по умолчанию', await p.locator('#dialog-slot input[type=checkbox]').isChecked());
  await p.click('#dialog-confirm');

  // Главное: пароль должен показаться, а не пропасть за редиректом.
  const shown = await p
    .waitForSelector('#dialog-slot .secret-value', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check('новый пароль показан', shown, shown ? '' : `страница: ${p.url()}`);

  let newPassword = null;
  if (shown) {
    newPassword = (await p.textContent('#dialog-slot .secret-value')).trim();
    check('пароль непустой', newPassword.length >= 20, `${newPassword.length} символов`);
    check('не увело на форму входа до показа', p.url().endsWith('/admin'), p.url());

    await p.click('#dialog-confirm');
    // После закрытия — осознанный уход на форму входа.
    const wentToLogin = await p
      .waitForURL(`${server.baseUrl}/login`, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    check('после закрытия уводит на форму входа', wentToLogin, p.url());

    const relogin = await ctx.request(ctx.app).post('/api/login').send({
      username: 'admin',
      password: newPassword,
    });
    check('показанным паролем можно войти', relogin.status === 200, `код ${relogin.status}`);
  }

  check('нет ошибок JavaScript', errors.length === 0, errors.join(' | '));

  await browser.close();
  require('../../src/ssh/manager').closeAll('selfreset');
  await server.close();
});
