/*
 * Проверка админки в настоящем браузере: реальный Chromium, реальный
 * backend, реальный sshd. Отдельный сценарий от browser-e2e.js, потому что
 * здесь вход выполняется администратором — со второй ступенью TOTP.
 */
process.chdir(require('node:path').resolve(__dirname, '..', '..'));

const { freePort, requirePlaywright, run, shotsDir } = require('./harness');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { chromium, devices } = requirePlaywright();

const sshd = require('../helpers/sshd');
const keys = require('../helpers/keys');

const SHOTS = shotsDir();

let passed = 0;
let failed = 0;

function check(name, ok, extra = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
}

/* То, что реально отрисовано в терминале. */
async function terminalText(page) {
  return page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen');
    return screen ? screen.textContent || '' : '';
  });
}

async function waitForTerminalText(page, needle, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await terminalText(page)).includes(needle)) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

run('админка в браузере', async (report) => {
  const check = (label, ok, extra) => report.check(label, ok, extra);

  const APP_PORT = await freePort();
  process.env.PUBLIC_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

  const ctx = require('../helpers/context');
  const wsClient = require('../helpers/wsClient');
  const totp = require('../../src/auth/totp');

  const host = await sshd.start();
  const server = await wsClient.startServer(ctx.app, APP_PORT);

  ctx.resetDb();
  await ctx.createUser({ username: 'admin', role: 'admin' });
  await ctx.createUser({ username: 'operator', role: 'user' });

  const browser = await chromium.launch();
  const consoleErrors = [];
  // Ответы сервера собираем целиком: приватный ключ не должен появиться ни
  // в одном из них — это главное обещание этого API.
  const responseBodies = [];

  const desktop = await browser.newContext({
    locale: 'ru-RU',
    viewport: { width: 1280, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await desktop.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('response', async (res) => {
    if (!res.url().includes('/api/')) return;
    try {
      responseBodies.push(await res.text());
    } catch {
      /* тело недоступно — не наш случай */
    }
  });

  /* =================== вход администратора с TOTP =================== */

  await page.goto(`${server.baseUrl}/admin`, { waitUntil: 'networkidle' });
  check('гостя из админки уводит на форму входа', page.url().endsWith('/login'));

  await page.fill('#username', 'admin');
  await page.fill('#password', ctx.DEFAULT_PASSWORD);
  await page.click('#submit-credentials');

  await page.waitForSelector('#enroll-step:not(.hidden)', { timeout: 10000 });
  const secret = (await page.textContent('#enroll-secret')).trim();
  check('администратору сразу предлагается привязать 2FA', secret.length >= 16, `секрет ${secret.length} символов`);

  await page.fill('#enroll-code', totp.generateToken(secret));
  await page.click('#submit-enroll');
  await page.waitForSelector('#recovery-step:not(.hidden)', { timeout: 10000 });
  const recoveryCount = await page.locator('#recovery-codes li').count();
  check('выданы коды восстановления', recoveryCount > 0, `${recoveryCount} шт.`);

  await page.click('#recovery-done');
  await page.waitForURL(`${server.baseUrl}/`, { timeout: 10000 });

  await page.goto(`${server.baseUrl}/admin`, { waitUntil: 'networkidle' });
  check('админка открылась', page.url().endsWith('/admin'));
  check('видно, кто вошёл', (await page.textContent('#whoami')).includes('admin'));

  /* ======================== таблица пользователей ==================== */

  await page.waitForSelector('#users-table .data-table');
  const userRows = await page.locator('#users-table tbody tr').count();
  check('пользователи отрисованы таблицей', userRows === 2, `строк: ${userRows}`);
  check('на десктопе видна шапка таблицы', await page.locator('#users-table thead').isVisible());
  check(
    'своя строка отмечена',
    (await page.locator('#users-table tr[data-username="admin"]').getAttribute('data-self')) === 'true'
  );

  /* -------------------- создание с генерацией пароля ---------------- */

  await page.fill('#new-username', 'newcomer');
  await page.selectOption('#new-role', 'user');
  check('поле пароля выключено, пока включена генерация', await page.locator('#new-password').isDisabled());

  await page.click('#create-user-submit');
  await page.waitForSelector('#app-dialog[open] .secret-value', { timeout: 10000 });
  const generated = (await page.textContent('#dialog-slot .secret-value')).trim();
  check('сгенерированный пароль показан один раз', generated.length >= 20, `${generated.length} символов`);

  await page.click('#dialog-confirm');
  await page.waitForSelector('#app-dialog', { state: 'hidden' });

  await page.waitForSelector('#users-table tr[data-username="newcomer"]');
  check('новый пользователь появился в списке', true);

  const loginNew = await ctx.request(ctx.app).post('/api/login').send({
    username: 'newcomer',
    password: generated,
  });
  check('созданный пользователь реально может войти', loginNew.status === 200, `код ${loginNew.status}`);

  /* -------------------------- сброс пароля -------------------------- */

  const newcomerRow = page.locator('#users-table tr[data-username="newcomer"]');
  await newcomerRow.getByRole('button', { name: 'Сбросить пароль' }).click();
  await page.waitForSelector('#app-dialog[open]');
  check(
    'сброс пароля предупреждает о закрытии сессий',
    (await page.textContent('#dialog-message')).includes('закроются')
  );

  await page.click('#dialog-confirm');
  await page.waitForSelector('#dialog-slot .secret-value', { timeout: 10000 });
  const resetPassword = (await page.textContent('#dialog-slot .secret-value')).trim();
  check('новый пароль отличается от прежнего', resetPassword !== generated);
  await page.click('#dialog-confirm');
  await page.waitForSelector('#app-dialog', { state: 'hidden' });

  const oldLogin = await ctx.request(ctx.app).post('/api/login').send({
    username: 'newcomer',
    password: generated,
  });
  const newLogin = await ctx.request(ctx.app).post('/api/login').send({
    username: 'newcomer',
    password: resetPassword,
  });
  check('старый пароль больше не работает', oldLogin.status === 401, `код ${oldLogin.status}`);
  check('новый пароль работает', newLogin.status === 200, `код ${newLogin.status}`);

  /* ------------------- отключение с подтверждением ------------------ */

  await newcomerRow.getByRole('button', { name: 'Отключить' }).click();
  await page.waitForSelector('#app-dialog[open]');
  check('перед отключением спрашивают подтверждение', await page.locator('#dialog-title').isVisible());

  await page.click('#dialog-cancel');
  await page.waitForSelector('#app-dialog', { state: 'hidden' });
  check(
    'после отказа пользователь остался активен',
    (await newcomerRow.textContent()).includes('активен')
  );

  await newcomerRow.getByRole('button', { name: 'Отключить' }).click();
  await page.waitForSelector('#app-dialog[open]');
  await page.click('#dialog-confirm');
  await page.waitForSelector('#users-table tr[data-username="newcomer"]:has-text("отключён")', {
    timeout: 10000,
  });
  check('после подтверждения пользователь отключён', true);

  const disabledLogin = await ctx.request(ctx.app).post('/api/login').send({
    username: 'newcomer',
    password: resetPassword,
  });
  check('отключённый пользователь не входит', disabledLogin.status === 403, `код ${disabledLogin.status}`);

  await newcomerRow.getByRole('button', { name: 'Включить' }).click();
  await page.waitForSelector('#users-table tr[data-username="newcomer"]:has-text("активен")', {
    timeout: 10000,
  });
  check('включение возвращает доступ', true);

  /* ---------------- последний администратор не отключается ---------- */

  const adminRow = page.locator('#users-table tr[data-username="admin"]');
  await adminRow.getByRole('button', { name: 'Отключить' }).click();
  await page.waitForSelector('#app-dialog[open]');
  check(
    'при отключении себя предупреждают отдельно',
    (await page.textContent('#dialog-message')).includes('собственная')
  );
  await page.click('#dialog-confirm');
  await page.waitForSelector('#toast:not([hidden])', { timeout: 10000 });
  const toastText = await page.textContent('#toast');
  check('сервер не даёт снять последнего админа', toastText.includes('администратор'), toastText);
  check(
    'администратор остался активен',
    (await adminRow.textContent()).includes('активен')
  );

  /* ============================ SSH-хост ============================ */

  const sshStatus = await page.textContent('#ssh-status');
  check('до настройки хост помечен как ненастроенный', sshStatus.includes('не настроен'), sshStatus.slice(0, 80));
  check(
    'предупреждение про общий хост на виду',
    (await page.textContent('.notice-warn')).includes('общий для всех')
  );

  await page.fill('#ssh-host', '127.0.0.1');
  await page.fill('#ssh-port', String(host.port));
  await page.fill('#ssh-username', host.username);
  await page.fill('#ssh-key-text', host.privateKey);
  await page.click('#ssh-submit');

  await page.waitForSelector('#ssh-status:has-text("SHA256:")', { timeout: 15000 });
  const configured = await page.textContent('#ssh-status');
  check('после сохранения показан отпечаток ключа', /SHA256:/.test(configured));
  check('адрес показан целиком', configured.includes(`${host.username}@127.0.0.1:${host.port}`));
  check('форма ключа очищена после сохранения', (await page.inputValue('#ssh-key-text')) === '');

  /* ------------------ проба подключения из админки ------------------ */

  await page.click('#ssh-test');
  await page.waitForSelector('#ssh-test-result:not(.hidden)');
  await page.waitForFunction(
    () => !document.getElementById('ssh-test-result').textContent.includes('Проверяем'),
    null,
    { timeout: 20000 }
  );
  const probeText = await page.textContent('#ssh-test-result');
  check('проба подключения проходит', /Подключение прошло/.test(probeText), probeText.slice(0, 90));

  await page.screenshot({ path: path.join(SHOTS, 'admin-desktop.png'), fullPage: false });

  /* --- настроенный из админки хост действительно работает в терминале --- */

  const userCtx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1100, height: 720 } });
  const userPage = await userCtx.newPage();
  await userPage.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await userPage.fill('#username', 'operator');
  await userPage.fill('#password', ctx.DEFAULT_PASSWORD);
  await userPage.click('#submit-credentials');
  await userPage.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });
  await userPage.waitForSelector('.xterm-screen', { timeout: 15000 });
  await userPage.waitForSelector('#status[data-state="connected"]', { timeout: 25000 });
  await userPage.click('#terminal-host');
  await userPage.keyboard.type('echo ADMIN-CONFIGURED-OK');
  await userPage.keyboard.press('Enter');
  const ran = await waitForTerminalText(userPage, 'ADMIN-CONFIGURED-OK');
  check('хост, настроенный через админку, отдаёт живой шелл', ran);
  await userCtx.close();

  /* ------------------ замена ключа требует подтверждения ------------ */

  const fingerprintBefore = (await page.textContent('#ssh-status')).match(/SHA256:[^\s]+/)[0];

  const strangerKey = keys.generateEd25519OpenSsh();
  await page.fill('#ssh-key-text', strangerKey);
  await page.click('#ssh-submit');
  await page.waitForSelector('#app-dialog[open]');
  const replaceMessage = await page.textContent('#dialog-message');
  check('замена ключа предупреждает о безвозвратности', replaceMessage.includes('безвозвратно'), replaceMessage.slice(0, 90));

  await page.click('#dialog-cancel');
  await page.waitForSelector('#app-dialog', { state: 'hidden' });
  check(
    'после отказа ключ не тронут',
    (await page.textContent('#ssh-status')).includes(fingerprintBefore)
  );

  await page.click('#ssh-submit');
  await page.waitForSelector('#app-dialog[open]');
  await page.click('#dialog-confirm');
  await page.waitForFunction(
    (before) => !document.getElementById('ssh-status').textContent.includes(before),
    fingerprintBefore,
    { timeout: 15000 }
  );
  check('после подтверждения отпечаток сменился', true);

  /* ---------------------- загрузка ключа файлом --------------------- */

  const keyFile = path.join(os.tmpdir(), `admin-e2e-key-${process.pid}`);
  fs.writeFileSync(keyFile, host.privateKey, { mode: 0o600 });
  await page.setInputFiles('#ssh-key-file', keyFile);
  await page.waitForFunction(
    () => document.getElementById('ssh-key-text').value.includes('PRIVATE KEY'),
    null,
    { timeout: 10000 }
  );
  check('файл ключа попадает в поле ввода', true);

  await page.click('#ssh-submit');
  await page.waitForSelector('#app-dialog[open]');
  await page.click('#dialog-confirm');
  await page.waitForSelector('#ssh-status:has-text("' + fingerprintBefore + '")', { timeout: 15000 });
  check('рабочий ключ вернулся на место', true);
  fs.rmSync(keyFile, { force: true });

  /* ============================== журнал ============================ */

  await page.click('#audit-refresh');
  await page.waitForSelector('#audit-table .data-table');
  const auditRows = await page.locator('#audit-table tbody tr').count();
  check('журнал показывает записи', auditRows > 5, `строк: ${auditRows}`);
  check('журнал не превышает сотню', auditRows <= 100, `строк: ${auditRows}`);

  const auditText = await page.textContent('#audit-table');
  for (const action of ['user.created', 'user.password_reset', 'ssh_config.key_replaced', 'terminal.open']) {
    check(`в журнале есть ${action}`, auditText.includes(action));
  }
  check('журнал поясняет действия по-русски', auditText.includes('Создан пользователь'));
  check('счётчик записей показан', (await page.textContent('#audit-count')).length > 0);

  // Журнал обновляется сам после действия в другом разделе.
  const before = await page.locator('#audit-table tbody tr').count();
  await page.fill('#new-username', 'second');
  await page.click('#create-user-submit');
  await page.waitForSelector('#dialog-slot .secret-value', { timeout: 10000 });
  await page.click('#dialog-confirm');
  await page.waitForFunction(
    (count) => document.querySelectorAll('#audit-table tbody tr').length > count,
    before,
    { timeout: 10000 }
  );
  check('журнал перечитывается после действия', true);

  /* ------------------- ключ не покидает сервер ---------------------- */

  /* ------------------- passphrase: задать и убрать ------------------ */

  const PASSPHRASE = 'e2e-secret-passphrase-42';
  await page.fill('#ssh-passphrase', PASSPHRASE);
  await page.click('#ssh-submit');
  await page.waitForSelector('#ssh-status:has-text("задана")', { timeout: 15000 });
  check('passphrase сохранена', true);

  await page.click('#ssh-passphrase-clear');
  check('«убрать» выключает поле ввода', await page.locator('#ssh-passphrase').isDisabled());
  await page.click('#ssh-submit');
  await page.waitForSelector('#app-dialog[open]');
  check(
    'удаление passphrase подтверждается',
    (await page.textContent('#dialog-message')).includes('passphrase будет удалена')
  );
  await page.click('#dialog-confirm');
  await page.waitForFunction(
    () => document.getElementById('ssh-status').textContent.includes('Passphraseнет'),
    null,
    { timeout: 15000 }
  );
  check('passphrase убрана', true);

  /* ------------------- ключ не покидает сервер ---------------------- */

  const leaked = responseBodies.filter((body) => body.includes('PRIVATE KEY'));
  check('приватный ключ не встречается ни в одном ответе API', leaked.length === 0, `${leaked.length} ответов`);
  // Проверяем само значение, а не имя поля: в журнале ключ "passphrase"
  // встречается со значением "[redacted]" — это и есть работающая вычистка.
  const passLeak = responseBodies.filter((body) => body.includes(PASSPHRASE));
  check('passphrase ни разу не вернулась наружу', passLeak.length === 0, `${passLeak.length} ответов`);

  /* ======================= мобильный экран ========================== */

  const iphone = devices['iPhone 13'];
  const mobile = await browser.newContext({ ...iphone, locale: 'ru-RU' });
  const mpage = await mobile.newPage();
  mpage.on('pageerror', (err) => consoleErrors.push(`mobile pageerror: ${err.message}`));

  await mpage.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await mpage.fill('#username', 'admin');
  await mpage.fill('#password', ctx.DEFAULT_PASSWORD);
  await mpage.click('#submit-credentials');
  await mpage.waitForSelector('#verify-step:not(.hidden)', { timeout: 10000 });

  // Повторный вход в тот же 30-секундный шаг отбивается защитой от
  // повторного кода — она проверяется отдельно, здесь мешала бы.
  ctx.getDb().prepare("UPDATE users SET totp_last_step = NULL WHERE username = 'admin'").run();
  await mpage.fill('#verify-code', totp.generateToken(secret));
  await mpage.click('#submit-verify');
  await mpage.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });

  await mpage.goto(`${server.baseUrl}/admin`, { waitUntil: 'networkidle' });
  await mpage.waitForSelector('#users-table .data-table');

  const overflow = await mpage.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  check(
    'на мобильном нет горизонтальной прокрутки',
    overflow.scroll <= overflow.client + 1,
    `${overflow.scroll} vs ${overflow.client}`
  );

  check('шапка таблицы скрыта', !(await mpage.locator('#users-table thead').isVisible()));

  const label = await mpage.evaluate(() => {
    const td = document.querySelector('#users-table tbody td');
    return getComputedStyle(td, '::before').content;
  });
  check('подпись колонки переехала в ячейку', label.includes('Логин'), label);

  const cardDisplay = await mpage.evaluate(
    () => getComputedStyle(document.querySelector('#users-table tbody tr')).display
  );
  check('строка стала блоком-карточкой', cardDisplay === 'block', cardDisplay);

  const smallButtons = await mpage.evaluate(() =>
    Array.from(document.querySelectorAll('#users-table button'))
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.height < 44).length
  );
  check('кнопки в списке не мельче 44px', smallButtons === 0, `мелких: ${smallButtons}`);

  const smallFonts = await mpage.evaluate(() =>
    Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=file]), select, textarea'))
      .filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16).length
  );
  check('поля ввода не мельче 16px (иначе iOS зумит)', smallFonts === 0, `мелких: ${smallFonts}`);

  // Диалог на узком экране должен помещаться целиком.
  await mpage.locator('#users-table tr[data-username="newcomer"]').getByRole('button', { name: 'Отключить' }).click();
  await mpage.waitForSelector('#app-dialog[open]');
  const dialogBox = await mpage.locator('#app-dialog').boundingBox();
  const viewportWidth = await mpage.evaluate(() => window.innerWidth);
  check(
    'диалог помещается в экран',
    dialogBox.width <= viewportWidth && dialogBox.x >= 0,
    `${Math.round(dialogBox.width)} при ширине ${viewportWidth}`
  );

  await mpage.keyboard.press('Escape');
  await mpage.waitForSelector('#app-dialog', { state: 'hidden' });
  check('Escape закрывает диалог', true);

  const auditOverflow = await mpage.evaluate(() => {
    const table = document.querySelector('#audit-table');
    return { scroll: table.scrollWidth, client: table.clientWidth };
  });
  check(
    'журнал тоже без горизонтальной прокрутки',
    auditOverflow.scroll <= auditOverflow.client + 1,
    `${auditOverflow.scroll} vs ${auditOverflow.client}`
  );

  await mpage.screenshot({ path: path.join(SHOTS, 'admin-mobile.png'), fullPage: false });

  /* --------------------- обычному пользователю закрыто -------------- */

  const plain = await browser.newContext({ locale: 'ru-RU' });
  const ppage = await plain.newPage();
  await ppage.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  await ppage.fill('#username', 'operator');
  await ppage.fill('#password', ctx.DEFAULT_PASSWORD);
  await ppage.click('#submit-credentials');
  await ppage.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });
  await ppage.goto(`${server.baseUrl}/admin`, { waitUntil: 'networkidle' });
  check('обычного пользователя уводит из админки в терминал', ppage.url() === `${server.baseUrl}/`, ppage.url());
  await plain.close();

  check('в консоли браузера нет ошибок JavaScript', consoleErrors.length === 0, consoleErrors.join(' | '));

  console.log('[этап] закрываю браузер');
  await browser.close();
  console.log('[этап] браузер закрыт');

  // Терминалы, поднятые за прогон, закрываем явно: server.close() ждёт
  // завершения соединений, а WebSocket сам не закроется никогда.
  require('../../src/ssh/manager').closeAll('e2e_done');
  console.log('[этап] закрываю http-сервер');
  // close() у хелпера возвращает промис, а не принимает колбэк.
  await server.close();
  console.log('[этап] сервер закрыт, останавливаю sshd');
  await host.stop();
  console.log('[этап] sshd остановлен');

});
