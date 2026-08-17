'use strict';

const http = require('node:http');
const { StringDecoder } = require('node:string_decoder');

const WebSocket = require('ws');

const { createWebSocketServer } = require('../../src/ws/server');

/**
 * Поднимает настоящий http-сервер с приложением и WebSocket-обработчиком.
 * Через supertest это не проверить: ему нужен upgrade реального сокета.
 */
function startServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    createWebSocketServer({ server, sessionMiddleware: app.get('sessionMiddleware') });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/ws/terminal`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

/**
 * Клиент терминала: копит двоичный вывод PTY и разбирает управляющие
 * JSON-сообщения, то есть ведёт себя так же, как будет вести фронтенд.
 */
class TerminalClient {
  constructor(ws) {
    this.ws = ws;
    this.output = Buffer.alloc(0);
    this.messages = [];
    this.closed = null;

    /**
     * Порции приходят с произвольными границами, и последняя может
     * обрываться посреди многобайтового символа. StringDecoder придерживает
     * незавершённую последовательность до следующей порции — как и положено
     * делать настоящему клиенту. Символ замены в собранном тексте после
     * этого означает уже настоящую порчу байтов, а не момент чтения.
     */
    this.decoder = new StringDecoder('utf8');
    this.decoded = '';

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.output = Buffer.concat([this.output, raw]);
        this.decoded += this.decoder.write(raw);
        return;
      }
      try {
        this.messages.push(JSON.parse(raw.toString('utf8')));
      } catch {
        this.messages.push({ type: 'unparsable', raw: raw.toString('utf8') });
      }
    });

    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString('utf8') };
    });
  }

  get text() {
    return this.decoded;
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  write(data) {
    this.send({ type: 'data', data });
  }

  resize(cols, rows) {
    this.send({ type: 'resize', cols, rows });
  }

  message(type) {
    return this.messages.find((m) => m.type === type);
  }

  async waitFor(predicate, { timeoutMs = 15_000, label = 'условия' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate(this)) return this;
      if (Date.now() > deadline) {
        throw new Error(
          `Не дождались ${label}. Получено: сообщения=${JSON.stringify(this.messages)}, ` +
            `вывод=${JSON.stringify(this.text.slice(-400))}, закрытие=${JSON.stringify(this.closed)}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  waitForOutput(needle, options) {
    return this.waitFor((c) => c.text.includes(needle), { label: `вывода "${needle}"`, ...options });
  }

  waitForMessage(type, options) {
    return this.waitFor((c) => Boolean(c.message(type)), { label: `сообщения "${type}"`, ...options });
  }

  waitForClose(options) {
    return this.waitFor((c) => c.closed !== null, { label: 'закрытия соединения', ...options });
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

/**
 * @returns {Promise<{client: TerminalClient}|{rejected: {status: number}}>}
 * Отказ до рукопожатия приходит кодом HTTP, а не кадром закрытия — поэтому
 * два разных исхода.
 */
function connect(wsUrl, { cookie, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (origin) headers.Origin = origin;

    const ws = new WebSocket(wsUrl, { headers });
    const client = new TerminalClient(ws);

    ws.once('open', () => resolve({ client }));
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve({ rejected: { status: res.statusCode } });
    });
    ws.once('error', (err) => {
      if (client.closed || ws.readyState === WebSocket.CLOSED) return;
      reject(err);
    });
  });
}

/** Cookie сессии из ответа на вход — для передачи в заголовке WebSocket. */
function cookieFrom(response) {
  const setCookie = response.headers['set-cookie'];
  if (!setCookie) return null;
  return setCookie.map((entry) => entry.split(';')[0]).join('; ');
}

module.exports = { startServer, connect, cookieFrom, TerminalClient };
