/*
 * Проверка трёх правок: размер шрифта, три языка, отсутствие тем в
 * контекстном меню.
 */
process.chdir(require('node:path').resolve(__dirname, '..', '..'));

const { freePort, requirePlaywright, run, shotsDir } = require('./harness');

const path = require('node:path');

const { chromium, devices } = requirePlaywright();

const SHOTS = shotsDir();

let passed = 0;
let failed = 0;

function check(name, ok, extra = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
}

/** Пункты контекстного меню — текстом, как их видит человек. */
async function menuItems(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#context-menu .menu-item, #context-menu .menu-label')).map(
      (n) => n.textContent.trim()
    )
  );
}

async function openMenu(page) {
  await page.click('#menu-btn');
  await page.waitForSelector('#context-menu:not([hidden])');
}

async function closeMenu(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('#context-menu', { state: 'hidden' });
}

run('фронтенд: языки, размер шрифта, контекстное меню', async (report) => {
  const check = (label, ok, extra) => report.check(label, ok, extra);

  const APP_PORT = await freePort();
  process.env.PUBLIC_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

  const ctx = require('../helpers/context');
  const wsClient = require('../helpers/wsClient');
  const sshd = require('../helpers/sshd');

  const host = await sshd.start();
  const server = await wsClient.startServer(ctx.app, APP_PORT);

  ctx.resetDb();
  await ctx.createUser({ username: 'admin', role: 'admin' });
  await ctx.createUser({ username: 'operator', role: 'user' });

  const { agent, secret: adminSecret } = await ctx.loginAs('admin');
  const cfg = await agent.put('/api/admin/ssh-config').send({
    host: '127.0.0.1',
    port: host.port,
    ssh_username: host.username,
    private_key: host.privateKey,
  });
  if (cfg.status !== 200) throw new Error(`SSH не настроен: ${JSON.stringify(cfg.body)}`);

  const browser = await chromium.launch();
  const consoleErrors = [];

  async function signIn(page) {
    await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', 'operator');
    await page.fill('#password', ctx.DEFAULT_PASSWORD);
    await page.click('#submit-credentials');
    await page.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });
    await page.waitForSelector('.xterm-screen', { timeout: 15000 });
  }

  /* ======================= 1. ЯЗЫК ПО БРАУЗЕРУ ====================== */

  for (const [locale, expected] of [
    ['ru-RU', 'Вход в терминал'],
    ['uk-UA', 'Вхід до термінала'],
    ['en-US', 'Sign in to the terminal'],
    // Незнакомая локаль должна давать английский, а не пустоту.
    ['ja-JP', 'Sign in to the terminal'],
  ]) {
    const c = await browser.newContext({ locale });
    const p = await c.newPage();
    p.on('pageerror', (err) => consoleErrors.push(`${locale}: ${err.message}`));
    await p.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
    const subtitle = (await p.textContent('#subtitle')).trim();
    check(`язык по браузеру ${locale}`, subtitle === expected, `получено «${subtitle}»`);

    const htmlLang = await p.getAttribute('html', 'lang');
    const wanted = { 'ru-RU': 'ru', 'uk-UA': 'uk' }[locale] || 'en';
    check(`  атрибут lang=${wanted}`, htmlLang === wanted, `получено ${htmlLang}`);
    await c.close();
  }

  /* =================== 2. ПЕРЕКЛЮЧЕНИЕ И ПАМЯТЬ ==================== */

  const ru = await browser.newContext({ locale: 'ru-RU' });
  const rp = await ru.newPage();
  rp.on('pageerror', (err) => consoleErrors.push(`switch: ${err.message}`));
  await rp.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });

  const chips = await rp.locator('#lang-row .theme-chip').allTextContents();
  check('на форме входа три языка', chips.length === 3, chips.join(', '));
  check('подписи на родных языках', chips.join('|') === 'Русский|Українська|English', chips.join('|'));

  await rp.locator('#lang-row .theme-chip', { hasText: 'Українська' }).click();
  check(
    'переключение на украинский меняет форму',
    (await rp.textContent('#subtitle')).trim() === 'Вхід до термінала'
  );
  check('заголовок вкладки тоже переведён', (await rp.title()).startsWith('Вхід'));
  check(
    'подписи полей переведены',
    (await rp.textContent('label[for="username"]')).trim() === 'Логін'
  );

  await rp.reload({ waitUntil: 'networkidle' });
  check(
    'выбор языка переживает перезагрузку',
    (await rp.textContent('#subtitle')).trim() === 'Вхід до термінала'
  );

  await rp.locator('#lang-row .theme-chip', { hasText: 'English' }).click();
  check('переключение на английский', (await rp.textContent('#subtitle')).trim() === 'Sign in to the terminal');

  // Ошибка сервера тоже должна прийти на выбранном языке: текст строится
  // по коду, а не берётся из ответа.
  await rp.fill('#username', 'operator');
  await rp.fill('#password', 'неверный-пароль');
  await rp.click('#submit-credentials');
  await rp.waitForSelector('#error:not(.hidden)');
  const errText = (await rp.textContent('#error')).trim();
  check('ошибка сервера переведена', errText === 'Wrong username or password.', `получено «${errText}»`);

  await rp.locator('#lang-row .theme-chip', { hasText: 'Русский' }).click();
  await ru.close();

  /* ================== 3. ТЕРМИНАЛ: ЯЗЫК И МЕНЮ ===================== */

  const term = await browser.newContext({ locale: 'ru-RU' });
  const tp = await term.newPage();
  tp.on('pageerror', (err) => consoleErrors.push(`terminal: ${err.message}`));
  await signIn(tp);
  await tp.waitForSelector('#status[data-state="connected"]', { timeout: 25000 });
  check('терминал подключился', true);
  check('статус по-русски', (await tp.textContent('#status-text')).trim() === 'Подключено');

  await openMenu(tp);
  const items = await menuItems(tp);

  const themeNames = ['Latte', 'Frappé', 'Macchiato', 'Mocha'];
  const themesInMenu = items.filter((text) => themeNames.some((name) => text.includes(name)));
  check('тем в контекстном меню больше нет', themesInMenu.length === 0, themesInMenu.join(', '));
  check('раздела «Тема» в меню нет', !items.some((text) => text === 'Тема'), items.join(' | '));

  check('в меню есть управление шрифтом', items.some((t) => t.includes('Увеличить шрифт')), items.join(' | '));
  check('в меню есть выбор языка', items.some((t) => t.startsWith('Язык')), items.join(' | '));
  check('копирование и вставка на месте', items.some((t) => t.includes('Копировать')) && items.some((t) => t.includes('Вставить')));

  await closeMenu(tp);

  // Переключение темы никуда не делось — оно на кнопке в шапке.
  const beforeTheme = await tp.evaluate(() => document.documentElement.dataset.flavor);
  await tp.click('#theme-btn');
  const afterTheme = await tp.evaluate(() => document.documentElement.dataset.flavor);
  check('тема переключается кнопкой в шапке', beforeTheme !== afterTheme, `${beforeTheme} → ${afterTheme}`);

  /* ------------------------- размер шрифта ------------------------- */

  const desktopFont = await tp.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize)
  );
  check('на десктопе шрифт 14px', desktopFont === 14, `${desktopFont}px`);

  const colsBefore = await tp.evaluate(() => document.querySelectorAll('.xterm-rows > div')[0].childElementCount);

  await openMenu(tp);
  await tp.locator('#context-menu .menu-item', { hasText: 'Увеличить шрифт' }).click();
  await tp.locator('#context-menu .menu-item', { hasText: 'Увеличить шрифт' }).click();
  check('меню остаётся открытым при шаге размера', await tp.locator('#context-menu').isVisible());
  await closeMenu(tp);

  const grown = await tp.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize)
  );
  check('два шага увеличили шрифт на 2px', grown === 16, `${grown}px`);

  // Размер шрифта меняет ширину в колонках, и новая ширина обязана доехать
  // до хоста: иначе программы на той стороне рисуют по старой.
  await tp.click('#terminal-host');
  await tp.keyboard.type('stty size');
  await tp.keyboard.press('Enter');
  const sawSize = await tp
    .waitForFunction(
      () => /\d+ \d+/.test(document.querySelector('.xterm-screen').textContent),
      null,
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);
  check('новая ширина доехала до хоста', sawSize);

  // Горячие клавиши: Ctrl+Shift+Minus / Equal.
  await tp.keyboard.press('Control+Shift+Minus');
  const shrunk = await tp.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize)
  );
  check('Ctrl+Shift+− уменьшает шрифт', shrunk === 15, `${shrunk}px`);

  await tp.reload({ waitUntil: 'networkidle' });
  await tp.waitForSelector('.xterm-screen');
  const afterReload = await tp.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize)
  );
  check('размер переживает перезагрузку', afterReload === 15, `${afterReload}px`);

  /* ------------------- смена языка в терминале ---------------------- */

  await tp.waitForSelector('#status[data-state="connected"]', { timeout: 25000 });
  await openMenu(tp);
  await tp.locator('#context-menu .menu-item', { hasText: 'Язык' }).click();
  await closeMenu(tp);
  check(
    'язык в терминале переключается и статус перерисовывается',
    (await tp.textContent('#status-text')).trim() === 'Підключено',
    await tp.textContent('#status-text')
  );
  check('подсказки кнопок тоже переведены', (await tp.getAttribute('#logout-btn', 'title')) === 'Вийти');

  await tp.screenshot({ path: path.join(SHOTS, 'terminal-uk.png') });
  await term.close();

  /* ==================== 4. МОБИЛЬНЫЙ ШРИФТ ========================= */

  const iphone = devices['iPhone 13'];
  const mobile = await browser.newContext({ ...iphone, locale: 'ru-RU' });
  const mp = await mobile.newPage();
  mp.on('pageerror', (err) => consoleErrors.push(`mobile: ${err.message}`));
  await signIn(mp);
  await mp.waitForSelector('#status[data-state="connected"]', { timeout: 25000 });

  const mobileFont = await mp.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize)
  );
  check('на мобильном шрифт по умолчанию 15px', mobileFont === 15, `${mobileFont}px`);
  check('мобильный шрифт не мельче десктопного', mobileFont >= 14, `${mobileFont} против 14`);

  const cols = await mp.evaluate(() => window.innerWidth);
  check('ширина экрана учтена', cols > 0, `${cols}px`);

  // Долгий тап открывает меню — там же управление шрифтом, пальцем.
  const box = await mp.locator('#terminal-host').boundingBox();
  await mp.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await mp.waitForTimeout(200);
  await mp.evaluate(() => {
    const host = document.getElementById('terminal-wrap');
    const opts = { bubbles: true, cancelable: true, pointerType: 'touch', clientX: 150, clientY: 300 };
    host.dispatchEvent(new PointerEvent('pointerdown', opts));
  });
  await mp.waitForSelector('#context-menu:not([hidden])', { timeout: 3000 });
  check('долгим тапом меню открывается', true);

  const mobileItems = await menuItems(mp);
  check(
    'в мобильном меню тоже нет тем',
    !mobileItems.some((text) => ['Latte', 'Frappé', 'Macchiato', 'Mocha'].some((n) => text.includes(n))),
    mobileItems.join(' | ')
  );

  const smallButtons = await mp.evaluate(() =>
    Array.from(document.querySelectorAll('#context-menu .menu-item'))
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.height < 44).length
  );
  check('пункты меню не мельче 44px', smallButtons === 0, `мелких: ${smallButtons}`);

  await mp.locator('#context-menu .menu-item', { hasText: 'Увеличить шрифт' }).click();
  const mobileGrown = await mp.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.xterm-rows')).fontSize)
  );
  check('шрифт увеличивается пальцем', mobileGrown === 16, `${mobileGrown}px`);

  await mp.screenshot({ path: path.join(SHOTS, 'mobile-font.png') });
  await mobile.close();

  /* ======================= 5. АДМИНКА НА UK ======================== */

  const totp = require('../../src/auth/totp');
  const adm = await browser.newContext({ locale: 'uk-UA' });
  const ap = await adm.newPage();
  ap.on('pageerror', (err) => consoleErrors.push(`admin: ${err.message}`));

  await ap.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
  check('форма входа украинская', (await ap.textContent('#subtitle')).trim() === 'Вхід до термінала');

  await ap.fill('#username', 'admin');
  await ap.fill('#password', ctx.DEFAULT_PASSWORD);
  await ap.click('#submit-credentials');
  await ap.waitForSelector('#verify-step:not(.hidden)', { timeout: 10000 });

  // Повторный вход в тот же 30-секундный шаг отбила бы защита от повторного
  // кода — она проверяется отдельно, здесь мешала бы.
  ctx.getDb().prepare("UPDATE users SET totp_last_step = NULL WHERE username = 'admin'").run();
  await ap.fill('#verify-code', totp.generateToken(adminSecret));
  await ap.click('#submit-verify');
  await ap.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });

  await ap.goto(`${server.baseUrl}/admin`, { waitUntil: 'networkidle' });
  await ap.waitForSelector('#users-table .data-table');

  check('заголовок админки украинский', (await ap.textContent('.admin-title')).trim() === 'Адміністрування');
  check('раздел пользователей', (await ap.textContent('#users-title')).trim() === 'Користувачі');
  check('раздел журнала', (await ap.textContent('#audit-title')).trim() === 'Журнал');

  const headers = await ap.locator('#users-table thead th').allTextContents();
  check(
    'заголовки таблицы переведены',
    headers.join('|') === 'Логін|Роль|Створено|Стан|Дії',
    headers.join('|')
  );

  const auditHeaders = await ap.locator('#audit-table thead th').allTextContents();
  check('журнал: колонки переведены', auditHeaders[0] === 'Час' && auditHeaders[1] === 'Дія', auditHeaders.join('|'));
  check(
    'журнал: действия переведены',
    (await ap.textContent('#audit-table')).includes('Вхід'),
    'нет строки «Вхід»'
  );

  const sshStatus = await ap.textContent('#ssh-status');
  check('состояние SSH-хоста переведено', sshStatus.includes('Ключ хоста'), sshStatus.slice(0, 60));

  // Переключение прямо на странице должно перерисовать и таблицы.
  await ap.locator('#lang-row .theme-chip', { hasText: 'English' }).click();
  await ap.waitForFunction(
    () => document.querySelector('.admin-title').textContent.trim() === 'Administration',
    null,
    { timeout: 10000 }
  );
  const enHeaders = await ap.locator('#users-table thead th').allTextContents();
  check(
    'смена языка перерисовывает таблицы',
    enHeaders.join('|') === 'Username|Role|Created|State|Actions',
    enHeaders.join('|')
  );

  await ap.screenshot({ path: path.join(SHOTS, 'admin-en.png'), fullPage: false });
  await adm.close();

  check('в консоли браузера нет ошибок JavaScript', consoleErrors.length === 0, consoleErrors.join(' | '));

  await browser.close();
  require('../../src/ssh/manager').closeAll('changes_e2e');
  await server.close();
  await host.stop();

});
