'use strict';

const http = require('node:http');

const { WebSocketServer } = require('ws');

const config = require('../config');
const { resolveSessionUser } = require('../auth/rbac');
const manager = require('../ssh/manager');
const { TerminalSession } = require('../ssh/session');
const { CLOSE, failAndClose } = require('./protocol');

const PATH = '/ws/terminal';

/**
 * Адрес клиента с тем же правилом доверия, что и у express: доверяем ровно
 * config.trustProxyHops ближайшим прокси. Заголовок приходит от клиента, и
 * доверять всей цепочке значило бы разрешить подделать адрес в журнале.
 */
function clientIp(req) {
  const header = req.headers['x-forwarded-for'];
  if (header) {
    const chain = String(header)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const candidate = chain[chain.length - config.trustProxyHops];
    if (candidate) return candidate;
  }
  return req.socket.remoteAddress || null;
}

/**
 * Защита от cross-site WebSocket hijacking. На рукопожатие WebSocket не
 * распространяется ни SameSite, ни политика общего происхождения, поэтому
 * сверяем Origin вручную.
 *
 * Заголовок проверяется, когда он есть: браузер присылает его всегда, а
 * значит и страница злоумышленника пришлёт — со своим адресом. Клиенты вне
 * браузера (скрипты, тесты) Origin не шлют, и для них угрозы подмены
 * контекста не существует.
 */
function isOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin.replace(/\/+$/, '') === config.publicOrigin;
}

/**
 * Аутентификация на этапе upgrade. Прогоняем тот же middleware
 * express-session, что и на обычных запросах, — cookie одна и та же.
 * Требуется настоящий ServerResponse: express-session оборачивает
 * writeHead/end, и объект-заглушка привела бы к падению на некоторых путях.
 */
function loadSession(sessionMiddleware, req) {
  return new Promise((resolve) => {
    const res = new http.ServerResponse(req);
    sessionMiddleware(req, res, () => resolve());
  });
}

function createWebSocketServer({ server, sessionMiddleware }) {
  /*
   * maxPayload — единственная защита памяти, которая срабатывает ДО того,
   * как данные будут приняты: ws отбрасывает кадр, не дочитывая его. Всё,
   * что проверяется в обработчике сообщения, проверяется уже над принятым
   * в память буфером.
   */
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.limits.wsMaxMessageBytes,
  });

  server.on('upgrade', async (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isOriginAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      await loadSession(sessionMiddleware, req);
    } catch {
      socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Та же проверка, что и у REST: сессия действительна, учётная запись
    // активна, пароль не менялся после входа. Незавершённый вход (ожидание
    // второго фактора) сюда не проходит — там нет session.user.
    const { user, error } = resolveSessionUser(req);

    if (error) {
      // Отказ до рукопожатия: незачем открывать WebSocket, чтобы тут же
      // его закрыть, и код HTTP понятнее клиенту.
      const status = error === 'account_disabled' ? '403 Forbidden' : '401 Unauthorized';
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection({ ws, req, user });
    });
  });

  manager.startIdleSweeper();

  return wss;
}

function handleConnection({ ws, req, user }) {
  const permitted = manager.canOpen(user.id);

  if (!permitted.ok) {
    failAndClose(
      ws,
      permitted.code,
      permitted.error,
      permitted.error === 'session_limit_user'
        ? 'Достигнут предел одновременных сессий для вашей учётной записи.'
        : 'Достигнут общий предел одновременных сессий.'
    );
    return;
  }

  const session = new TerminalSession({
    ws,
    user,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'] || null,
  });

  manager.register(session);
  session.start();
}

module.exports = { createWebSocketServer, clientIp, isOriginAllowed, PATH, CLOSE };
