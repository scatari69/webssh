/*
 * Проверка фронтенда в настоящем браузере: реальный Chromium, реальный
 * backend, реальный sshd. Без этого «работает» — только предположение.
 */
process.chdir(require('node:path').resolve(__dirname, '..', '..'));

const { freePort, requirePlaywright, run, shotsDir } = require('./harness');

const { chromium, devices } = requirePlaywright();

/*
 * Порт выбирается ДО загрузки конфигурации приложения: проверка заголовка
 * Origin при upgrade сверяет его с PUBLIC_ORIGIN дословно, вместе с портом.
 * Иначе браузер, пришедший на 127.0.0.1:<порт>, получил бы 403 — что и
 * произошло при первом прогоне.
 */

const sshd = require('../helpers/sshd');
let ctx;
let wsClient;

const SHOTS = shotsDir();

/** Текст, отрисованный в буфере xterm, — то, что человек реально видит. */
async function terminalText(page) {
  return page.evaluate(() => {
    const rows = [];
    const term = window.__term;
    if (!term) return '';
    const buffer = term.buffer.active;
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i);
      if (line) rows.push(line.translateToString(true));
    }
    return rows.join('\n');
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

run('терминал в браузере: десктоп и мобильный', async (report) => {
  const check = (label, ok, extra) => report.check(label, ok, extra);

  const APP_PORT = await freePort();
  process.env.PUBLIC_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

  ctx = require('../helpers/context');
  wsClient = require('../helpers/wsClient');

  const host = await sshd.start();
  const server = await wsClient.startServer(ctx.app, APP_PORT);

  ctx.resetDb();
  await ctx.createUser({ username: 'admin', role: 'admin' });
  await ctx.createUser({ username: 'operator', role: 'user' });

  const { agent } = await ctx.loginAs('admin');
  const cfg = await agent.put('/api/admin/ssh-config').send({
    host: '127.0.0.1',
    port: host.port,
    ssh_username: host.username,
    private_key: host.privateKey,
  });
  if (cfg.status !== 200) throw new Error(`не настроен SSH: ${JSON.stringify(cfg.body)}`);

  const browser = await chromium.launch();
  const consoleErrors = [];

  /* ============================ ДЕСКТОП ============================ */
  const desktop = await browser.newContext({
    locale: 'ru-RU',
    viewport: { width: 1280, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await desktop.newPage();
  page.on('console', (msg) => {
    // Браузер пишет в консоль любой ответ 4xx. Неудачный вход в этой
    // проверке намеренный, и такие записи ошибкой приложения не являются —
    // интересуют исключения JavaScript.
    if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  // --- форма входа ---
  await page.goto(`${server.baseUrl}/`, { waitUntil: 'networkidle' });
  check('корень уводит на /login', page.url().endsWith('/login'));
  check('форма входа отрисована', await page.locator('#username').isVisible());

  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ctp-base').trim()
  );
  check('тема Mocha применена по умолчанию', bg === '#1e1e2e', `--ctp-base=${bg}`);

  // Переключение темы на форме входа и её сохранение
  await page.locator('.theme-chip', { hasText: 'Latte' }).click();
  const latte = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ctp-base').trim()
  );
  check('переключение на Latte применилось', latte === '#eff1f5', `--ctp-base=${latte}`);

  await page.reload({ waitUntil: 'networkidle' });
  const persisted = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ctp-base').trim()
  );
  check('тема пережила перезагрузку (localStorage)', persisted === '#eff1f5');

  await page.locator('.theme-chip', { hasText: 'Mocha' }).click();
  await page.screenshot({ path: `${SHOTS}/01-login-desktop.png` });

  // --- неверный пароль ---
  await page.fill('#username', 'operator');
  await page.fill('#password', 'неправильный-пароль');
  await page.click('#submit-credentials');
  await page.waitForSelector('#error:not(.hidden)', { timeout: 5000 });
  check('неверный пароль показывает ошибку', (await page.textContent('#error')).includes('Неверный'));

  // --- вход ---
  await page.fill('#password', ctx.DEFAULT_PASSWORD);
  await page.click('#submit-credentials');
  await page.waitForURL(`${server.baseUrl}/`, { timeout: 10000 });
  check('вход выполнен, открыт терминал', page.url() === `${server.baseUrl}/`);

  await page.waitForSelector('.xterm-screen', { timeout: 15000 });

  await page.waitForSelector('#status[data-state="connected"]', { timeout: 20000 });
  check('статус — «Подключено»', (await page.textContent('#status-text')).includes('Подключено'));
  check('перекрытие скрыто после подключения', await page.locator('#overlay').isHidden());

  // --- реальная команда через терминал ---
  await page.click('#terminal-host');
  await page.keyboard.type('echo BROWSER-PROOF-$((6*7))');
  await page.keyboard.press('Enter');

  const sawOutput = await page.waitForFunction(
    () => document.querySelector('.xterm-screen')?.textContent?.includes('BROWSER-PROOF-42'),
    null,
    { timeout: 20000 }
  ).then(() => true).catch(() => false);
  check('команда выполнена на настоящем хосте, вывод отрисован', sawOutput);

  await page.screenshot({ path: `${SHOTS}/02-terminal-desktop.png` });

  // --- размер PTY, вычисленный в браузере, доехал до настоящего хоста ---
  const openRow = ctx
    .getDb()
    .prepare("SELECT detail FROM audit_log WHERE action = 'terminal.open' ORDER BY id DESC LIMIT 1")
    .get();
  const dims = JSON.parse(openRow.detail);
  check('размеры окна дошли до сервера', dims.cols > 20 && dims.rows > 5, `${dims.cols}x${dims.rows}`);

  await page.keyboard.type('stty size');
  await page.keyboard.press('Enter');
  const sawDims = await page.waitForFunction(
    (expected) => document.querySelector('.xterm-screen')?.textContent?.includes(expected),
    `${dims.rows} ${dims.cols}`,
    { timeout: 15000 }
  ).then(() => true).catch(() => false);
  check('PTY на хосте того же размера, что и терминал в браузере', sawDims, `${dims.cols}x${dims.rows}`);

  // --- контекстное меню по правому клику ---
  await page.click('#terminal-host', { button: 'right' });
  await page.waitForSelector('#context-menu:not([hidden])', { timeout: 5000 });
  const menuItems = await page.locator('#context-menu .menu-item').allTextContents();
  check('контекстное меню открылось по правому клику', menuItems.length > 0);
  for (const expected of ['Копировать', 'Вставить', 'Очистить экран', 'Сбросить терминал', 'Скачать журнал сессии']) {
    check(`пункт «${expected}» присутствует`, menuItems.some((t) => t.includes(expected)));
  }
  // Выбор темы из меню убран по просьбе: он остался кнопкой в шапке.
  for (const flavor of ['Latte', 'Frappé', 'Macchiato', 'Mocha']) {
    check(`темы «${flavor}» в меню больше нет`, !menuItems.some((t) => t.includes(flavor)));
  }

  const smallTargets = await page.evaluate(() =>
    [...document.querySelectorAll('#context-menu .menu-item')]
      .map((el) => el.getBoundingClientRect().height)
      .filter((h) => h < 44).length
  );
  check('все пункты меню не меньше 44px по высоте', smallTargets === 0, `мелких: ${smallTargets}`);

  await page.screenshot({ path: `${SHOTS}/03-context-menu.png` });

  // --- смена темы кнопкой в шапке ---
  await page.keyboard.press('Escape');
  await page.waitForSelector('#context-menu', { state: 'hidden' });
  // Кнопка перебирает палитры по кругу. Считать клики от предполагаемой
  // начальной темы ненадёжно — жмём, пока не дойдём до нужной.
  for (let i = 0; i < 4; i += 1) {
    if ((await page.evaluate(() => document.documentElement.dataset.flavor)) === 'macchiato') break;
    await page.click('#theme-btn');
    await page.waitForTimeout(100);
  }
  const macchiato = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ctp-base').trim()
  );
  check('смена темы кнопкой в шапке применилась', macchiato === '#24273a', `--ctp-base=${macchiato}`);

  // Наблюдаемый признак применения темы к самому xterm — цвет текста,
  // который он ставит из theme.foreground.
  const xtermFg = await page.evaluate(
    () => getComputedStyle(document.querySelector('.xterm')).color
  );
  check('тема применилась и к полотну терминала', xtermFg === 'rgb(202, 211, 245)', `цвет текста=${xtermFg}`);

  // --- закрытие меню по Escape ---
  await page.click('#terminal-host', { button: 'right' });
  await page.waitForSelector('#context-menu:not([hidden])');
  await page.keyboard.press('Escape');
  check('меню закрывается по Escape', await page.locator('#context-menu').isHidden());

  // --- поиск ---
  await page.click('#search-btn');
  check('панель поиска открылась', await page.locator('#searchbar').isVisible());
  await page.fill('#search-input', 'BROWSER-PROOF');
  await page.click('#search-next');
  await page.click('#search-close');
  check('панель поиска закрылась', await page.locator('#searchbar').isHidden());

  // --- скачивание журнала ---
  await page.click('#terminal-host', { button: 'right' });
  await page.waitForSelector('#context-menu:not([hidden])');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.locator('#context-menu .menu-item', { hasText: 'Скачать журнал' }).click(),
  ]);
  const logPath = await download.path();
  const logText = require('node:fs').readFileSync(logPath, 'utf8');
  check('журнал сессии скачался', download.suggestedFilename().endsWith('.txt'));
  check('в журнале есть вывод команды', logText.includes('BROWSER-PROOF-42'));
  check('в журнале нет escape-последовательностей', !/\[/.test(logText));

  // --- панель спецклавиш на десктопе скрыта ---
  check('панель спецклавиш на десктопе скрыта', await page.locator('#keybar').isHidden());

  /* ============================ МОБИЛЬНЫЙ ============================ */
  const phone = await browser.newContext({
    locale: 'ru-RU',
    ...devices['iPhone 13'],
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const mobile = await phone.newPage();
  mobile.on('pageerror', (err) => consoleErrors.push(`mobile pageerror: ${err.message}`));

  await mobile.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });

  const inputFontSize = await mobile.evaluate(() =>
    parseFloat(getComputedStyle(document.getElementById('username')).fontSize)
  );
  check('шрифт полей ввода ≥16px (iOS не зумит форму)', inputFontSize >= 16, `${inputFontSize}px`);

  await mobile.screenshot({ path: `${SHOTS}/04-login-mobile.png` });

  await mobile.fill('#username', 'operator');
  await mobile.fill('#password', ctx.DEFAULT_PASSWORD);
  await mobile.click('#submit-credentials');
  await mobile.waitForURL(`${server.baseUrl}/`, { timeout: 15000 });
  await mobile.waitForSelector('#status[data-state="connected"]', { timeout: 25000 });
  check('на мобильном терминал подключился', true);

  check('панель спецклавиш на мобильном видна', await mobile.locator('#keybar').isVisible());

  const keyLabels = await mobile.locator('.keybar-key').allTextContents();
  for (const expected of ['Esc', 'Tab', 'Ctrl', '↑', '↓', '←', '→', '^C']) {
    check(`клавиша «${expected}» на панели`, keyLabels.includes(expected));
  }

  const smallKeys = await mobile.evaluate(() =>
    [...document.querySelectorAll('.keybar-key')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.height < 44 || r.width < 44).length
  );
  check('все клавиши панели не меньше 44x44', smallKeys === 0, `мелких: ${smallKeys}`);

  // Высота приложения равна видимой области, а не 100vh
  const heights = await mobile.evaluate(() => ({
    app: document.querySelector('.terminal-app').getBoundingClientRect().height,
    visual: window.visualViewport ? window.visualViewport.height : window.innerHeight,
    inner: window.innerHeight,
  }));
  check(
    'высота приложения привязана к видимой области',
    Math.abs(heights.app - heights.visual) < 2,
    `app=${heights.app} visual=${heights.visual}`
  );

  const overscroll = await mobile.evaluate(() => getComputedStyle(document.body).overscrollBehaviorY);
  check('pull-to-refresh отключён', overscroll === 'none', overscroll);

  /* --------------------- прокрутка пальцем --------------------- */

  // Наполняем буфер, чтобы было что листать.
  await mobile.locator('.xterm-screen').tap();
  await mobile.keyboard.type('seq 1 400\n');
  await waitForTerminalText(mobile, '400');
  await mobile.waitForTimeout(500);

  /**
   * Настоящий жест пальцем. Playwright умеет только tap, поэтому
   * последовательность касаний отправляется через CDP — иначе проверялся
   * бы синтетический PointerEvent, а не то, что делает браузер.
   */
  async function swipe(page, x, fromY, toY, steps = 12) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }] });
    for (let i = 1; i <= steps; i += 1) {
      const y = fromY + ((toY - fromY) * i) / steps;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  /** Номер верхней видимой строки — по нему и видно, listается ли экран. */
  const topLine = () =>
    mobile.evaluate(() => {
      const term = window.__term;
      const buffer = term.buffer.active;
      const line = buffer.getLine(buffer.viewportY);
      return line ? line.translateToString(true).trim() : '';
    });

  const hostBox = await mobile.locator('#terminal-host').boundingBox();
  const midX = hostBox.x + hostBox.width / 2;

  const atBottom = await topLine();
  await swipe(mobile, midX, hostBox.y + hostBox.height * 0.3, hostBox.y + hostBox.height * 0.8);
  await mobile.waitForTimeout(600);
  const afterUp = await topLine();
  check('протяжка пальцем вниз листает историю вверх', afterUp !== atBottom, `${atBottom} → ${afterUp}`);

  // Ровно то, чего не хватало: xterm 6 рисует только видимый экран, и
  // без своего обработчика жест не двигал буфер вовсе.
  check(
    'ушли именно назад по буферу',
    Number(afterUp) > 0 && Number(afterUp) < Number(atBottom),
    `было ${atBottom}, стало ${afterUp}`
  );

  await swipe(mobile, midX, hostBox.y + hostBox.height * 0.8, hostBox.y + hostBox.height * 0.2);
  await mobile.waitForTimeout(600);
  const afterDown = await topLine();
  check('протяжка вверх возвращает к концу', Number(afterDown) > Number(afterUp), `${afterUp} → ${afterDown}`);

  // Тап не должен листать: иначе курсор нельзя поставить, не сдвинув экран.
  const beforeTap = await topLine();
  await mobile.touchscreen.tap(midX, hostBox.y + hostBox.height / 2);
  await mobile.waitForTimeout(300);
  check('одиночный тап экран не двигает', (await topLine()) === beforeTap, beforeTap);

  // ...но фокус по тапу забирает — на мобильном только так открывается
  // системная клавиатура.
  const focused = await mobile.evaluate(() =>
    document.activeElement?.classList.contains('xterm-helper-textarea')
  );
  check('тап отдаёт фокус терминалу (иначе не открыть клавиатуру)', focused === true);

  // Долгий тап открывает меню
  const box = await mobile.locator('#terminal-host').boundingBox();
  await mobile.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 3);
  await mobile.evaluate(
    ([x, y]) => {
      const target = document.getElementById('terminal-wrap');
      const opts = { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, pointerId: 1 };
      target.dispatchEvent(new PointerEvent('pointerdown', opts));
    },
    [box.x + box.width / 2, box.y + box.height / 3]
  );
  const longPressOpened = await mobile
    .waitForSelector('#context-menu:not([hidden])', { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check('долгий тап открывает контекстное меню', longPressOpened);

  if (longPressOpened) {
    const menuBox = await mobile.locator('#context-menu').boundingBox();
    const vp = mobile.viewportSize();
    check(
      'меню не вылезает за границы экрана',
      menuBox.x >= 0 && menuBox.y >= 0 && menuBox.x + menuBox.width <= vp.width + 1,
      `x=${Math.round(menuBox.x)} w=${Math.round(menuBox.width)} vw=${vp.width}`
    );
    await mobile.screenshot({ path: `${SHOTS}/05-mobile-menu.png` });
    await mobile.keyboard.press('Escape');
  }

  // Ctrl как залипающий модификатор: Ctrl затем C должен прервать команду
  await mobile.evaluate(() => document.querySelector('.xterm-helper-textarea')?.focus());
  await mobile.locator('.keybar-key', { hasText: '^C' }).first().click();
  await mobile.waitForTimeout(400);

  await mobile.screenshot({ path: `${SHOTS}/06-terminal-mobile.png` });

  const ctrlPressed = await mobile.evaluate(() => {
    const btn = [...document.querySelectorAll('.keybar-key')].find((b) => b.textContent === 'Ctrl');
    return btn ? btn.getAttribute('aria-pressed') : null;
  });
  check('Ctrl по умолчанию отжат', ctrlPressed === 'false');

  await mobile.locator('.keybar-key', { hasText: 'Ctrl' }).first().click();
  const ctrlAfter = await mobile.evaluate(() => {
    const btn = [...document.querySelectorAll('.keybar-key')].find((b) => b.textContent === 'Ctrl');
    return btn.getAttribute('aria-pressed');
  });
  check('Ctrl залипает по нажатию', ctrlAfter === 'true');

  /* ============================ ИТОГ ============================ */
  check('в консоли браузера нет ошибок JavaScript', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  await browser.close();
  await server.close();
  await host.stop();

  console.log(`Снимки экрана: ${SHOTS}`);
});
