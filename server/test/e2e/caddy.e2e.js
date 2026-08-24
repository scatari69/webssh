/*
 * Проверка боевого Caddyfile настоящим Caddy: тот же файл из репозитория,
 * реальный процесс прокси, реальное приложение и реальный sshd за ним.
 *
 * TLS здесь не проверяется (для него нужен доверенный сертификат), поэтому
 * сайт поднимается с явной схемой http:// — всё остальное поведение
 * конфига при этом то же самое.
 */
process.chdir(require('node:path').resolve(__dirname, '..', '..'));

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ROOT, freePort, run, skip } = require('./harness');

const WebSocket = require('ws');

// Caddy держит данные и конфигурацию в HOME, а поднимается он здесь под
// тем же пользователем, что и тесты: без отдельного каталога он писал бы
// в настоящий ~/.local/share и оставлял мусор после прогона.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-caddy-e2e-'));
const CADDY = process.env.CADDY_BIN || 'caddy';
const CADDYFILE = path.join(ROOT, 'caddy', 'Caddyfile');

/**
 * Caddy в зависимости не входит и в образ приложения не попадает: перед
 * приложением он стоит отдельным контейнером. Здесь он нужен как
 * настоящий процесс, и без него набор пропускается.
 */
function requireCaddy() {
  try {
    execFileSync(CADDY, ['version'], { stdio: 'ignore' });
  } catch {
    skip(`caddy не найден (${CADDY}). Укажите путь в CADDY_BIN или поставьте его в PATH.`);
  }
}

async function waitFor(fn, { timeoutMs = 20000, label = 'условия' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* ещё не поднялось */
    }
    if (Date.now() > deadline) throw new Error(`не дождались ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

requireCaddy();

run('боевой Caddyfile настоящим Caddy', async (report) => {
  const check = (label, ok, extra) => report.check(label, ok, extra);

  const appPort = await freePort();
  const proxyPort = await freePort();
  const origin = `http://localhost:${proxyPort}`;

  process.env.PUBLIC_ORIGIN = origin;

  const ctx = require('../helpers/context');
  const wsClient = require('../helpers/wsClient');
  const sshd = require('../helpers/sshd');

  const host = await sshd.start();
  const server = await wsClient.startServer(ctx.app, appPort);

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
  if (cfg.status !== 200) throw new Error(`SSH не настроен: ${JSON.stringify(cfg.body)}`);

  // --- запускаем настоящий Caddy с конфигом из репозитория ---
  const caddy = spawn(CADDY, ['run', '--config', CADDYFILE, '--adapter', 'caddyfile'], {
    env: {
      ...process.env,
      HOME: SCRATCH,
      XDG_DATA_HOME: path.join(SCRATCH, 'caddy-data'),
      XDG_CONFIG_HOME: path.join(SCRATCH, 'caddy-config'),
      DOMAIN: origin,
      APP_UPSTREAM: `127.0.0.1:${appPort}`,
      ACME_EMAIL_DIRECTIVE: '',
      ACME_CA_DIRECTIVE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const caddyLog = [];
  caddy.stdout.on('data', (b) => caddyLog.push(b.toString()));
  caddy.stderr.on('data', (b) => caddyLog.push(b.toString()));

  try {
    try {
      await waitFor(async () => (await fetch(`${origin}/api/health`)).ok, { label: 'запуска Caddy' });
    } catch (err) {
      // Без лога самого Caddy «не дождались запуска» ничего не объясняет:
      // причина почти всегда в конфиге и печатается им в stderr.
      throw new Error(`${err.message}\n--- лог Caddy ---\n${caddyLog.join('').slice(-3000)}`);
    }
    check('Caddy поднялся с конфигом из репозитория', true);

    /* ------------------------- заголовки безопасности ------------------ */

    const res = await fetch(`${origin}/login`);
    check('страница проходит через прокси', res.status === 200, `код ${res.status}`);

    const expected = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'strict-transport-security': 'max-age=31536000',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    };
    for (const [header, value] of Object.entries(expected)) {
      check(`заголовок ${header}`, res.headers.get(header) === value, `получено ${res.headers.get(header)}`);
    }
    check(
      'Permissions-Policy запрещает камеру и микрофон',
      /camera=\(\)/.test(res.headers.get('permissions-policy') || '') &&
        /microphone=\(\)/.test(res.headers.get('permissions-policy') || '')
    );
    check('заголовок Server убран', !res.headers.get('server'), `получено ${res.headers.get('server')}`);
    check(
      'CSP приложения доходит через прокси',
      (res.headers.get('content-security-policy') || '').includes("default-src 'none'")
    );
    check('HSTS без includeSubDomains', !/includeSubDomains/i.test(res.headers.get('strict-transport-security') || ''));

    /* ------------------------------ размер тела ------------------------ */

    const big = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'y', pad: 'A'.repeat(2 * 1024 * 1024) }),
    });
    check('тело сверх 1 МБ прокси не пропускает', big.status === 413, `код ${big.status}`);

    const normal = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'operator', password: ctx.DEFAULT_PASSWORD }),
    });
    check('обычный вход через прокси работает', normal.status === 200, `код ${normal.status}`);

    const cookie = normal.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    check('cookie сессии выставлена', Boolean(cookie));
    check(
      'cookie httpOnly и SameSite=Lax',
      normal.headers.getSetCookie().every((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c)),
      normal.headers.getSetCookie().join(' | ')
    );

    /* --------------------------- WebSocket через Caddy ------------------ */

    const wsUrl = `ws://localhost:${proxyPort}/ws/terminal`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: origin } });
    const client = new wsClient.TerminalClient(ws);

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, r) => reject(new Error(`upgrade отклонён: ${r.statusCode}`)));
    });
    check('рукопожатие WebSocket проходит через reverse_proxy', true);

    await client.waitForMessage('ready');
    check('терминал готов', true);

    client.write('echo CADDY-PROXY-OK\n');
    await client.waitForOutput('CADDY-PROXY-OK');
    check('данные PTY ходят в обе стороны сквозь прокси', true);

    // Интерактивность: эхо приходит до того, как накопится буфер.
    const started = Date.now();
    client.write('printf "PING-BACK\\n"\n');
    await client.waitForOutput('PING-BACK');
    const latency = Date.now() - started;
    check('вывод не буферизуется (flush_interval -1)', latency < 3000, `${latency} мс`);

    client.close();
    await client.waitForClose();

    /* ------------------- адрес клиента доезжает до приложения ---------- */

    const open = ctx
      .getDb()
      .prepare("SELECT ip FROM audit_log WHERE action = 'terminal.open' ORDER BY id DESC LIMIT 1")
      .get();
    check(
      'X-Forwarded-For доходит до приложения',
      Boolean(open && open.ip),
      `в журнале: ${open && open.ip}`
    );

    /* --------------------- подделанный X-Forwarded-For ----------------- */

    // Клиент не должен уметь подменить свой адрес: Caddy принимает
    // X-Forwarded-For только от доверенных прокси, а от внешнего клиента
    // перезаписывает.
    const forged = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' },
      body: JSON.stringify({ username: 'operator', password: 'неверный' }),
    });
    check('подделанный вход отклонён', forged.status === 401, `код ${forged.status}`);

    const failedLogin = ctx
      .getDb()
      .prepare("SELECT ip FROM audit_log WHERE action = 'auth.login' AND outcome = 'failure' ORDER BY id DESC LIMIT 1")
      .get();
    check(
      'подделанный X-Forwarded-For в журнал не попадает',
      failedLogin && failedLogin.ip !== '203.0.113.7',
      `в журнале: ${failedLogin && failedLogin.ip}`
    );

    /* ------------------------------ маршрутизация ---------------------- */

    const notWs = await fetch(`${origin}/ws/terminal`);
    check('обычный GET на /ws/* не выдаёт терминал', notWs.status !== 101 && notWs.status !== 200, `код ${notWs.status}`);
  } finally {
    caddy.kill('SIGTERM');
    require('../../src/ssh/manager').closeAll('caddy_e2e');
    await server.close();
    await host.stop();
    // Каталог временный, и убрать его нужно в том числе после падения:
    // иначе каждый неудачный прогон оставляет копию данных Caddy в /tmp.
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }

  if (report.failed > 0) console.log('\nлог Caddy:\n' + caddyLog.join('').slice(-2000));
});
