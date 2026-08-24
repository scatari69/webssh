'use strict';

const net = require('node:net');

const { Client } = require('ssh2');

const configStore = require('./configStore');
const { createHostVerifier } = require('./hostKey');
const { classifyConnectionError } = require('./session');

/**
 * Проверка подключения к настроенному хосту — тем же ключом и тем же кодом,
 * которым пойдёт настоящий терминал.
 *
 * Заведена потому, что «работает из консоли сервера» и «работает у
 * приложения» — разные утверждения. Приложение живёт в контейнере со своей
 * сетевой областью: 127.0.0.1 там указывает на сам контейнер, а не на
 * машину, и ключ у него свой, а не тот, что лежит в ~/.ssh у человека.
 * Без такой пробы единственным способом проверить настройку было открыть
 * терминал и посмотреть, что получится.
 */

/** Адреса, которые внутри контейнера означают не то, что снаружи. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function loopbackHint(host) {
  return LOOPBACK.has(String(host).trim().toLowerCase()) ? 'loopback_in_container' : null;
}

/**
 * @returns {Promise<{ok: true, fingerprint: string|null, learned: boolean}
 *                  |{ok: false, error: string, hint: string|null, presented?: string}>}
 */
function testConnection() {
  const publicConfig = configStore.getPublic();

  if (!publicConfig.is_configured) {
    return Promise.resolve({ ok: false, error: 'ssh_not_configured', hint: null });
  }

  let secrets;
  try {
    secrets = configStore.loadConnectionSecrets();
    if (!secrets) throw new Error('ssh_key_missing');
  } catch {
    return Promise.resolve({ ok: false, error: 'ssh_key_unreadable', hint: null });
  }

  const cfg = configStore.rawRow();
  const hint = loopbackHint(cfg.host);

  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    let mismatch = null;
    let learned = false;
    let fingerprint = null;

    /*
     * TCP-соединение открываем сами и только потом отдаём его ssh2 через
     * параметр sock. Так у пробы есть чем владеть: сокет к недостижимому
     * адресу висит в SYN_SENT минутами, и без явного destroy он удерживает
     * event loop — процесс не завершается, хотя работа давно закончена.
     * Заодно свой таймаут на установление соединения, а не только на
     * рукопожатие SSH.
     */
    const socket = net.createConnection({ host: secrets.host, port: secrets.port });
    socket.setTimeout(cfg.connect_timeout_ms);

    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        // Соединение могло и не открыться — это не повод падать.
      }
      socket.destroy();
      resolve(result);
    };

    socket.once('timeout', () => done({ ok: false, error: 'ssh_timeout', hint }));
    socket.once('error', (err) =>
      done({ ok: false, error: classifyConnectionError(err).error, hint })
    );

    const hostVerifier = createHostVerifier(cfg, {
      onMismatch: (info) => {
        mismatch = info;
      },
      onLearn: (info) => {
        learned = true;
        fingerprint = info.fingerprint;
      },
    });

    conn.on('ready', () => {
      // Проверяем только рукопожатие и аутентификацию: шелл для ответа на
      // вопрос «доедет ли терминал» уже ничего не добавляет, а лишний
      // процесс на том конце — добавляет.
      done({
        ok: true,
        fingerprint: fingerprint || publicConfig.known_host_fingerprint,
        learned,
        hint: null,
      });
    });

    conn.on('error', (err) => {
      if (mismatch) {
        done({
          ok: false,
          error: 'ssh_host_key_mismatch',
          presented: mismatch.presented,
          expected: mismatch.expected,
          hint: null,
        });
        return;
      }
      done({ ok: false, error: classifyConnectionError(err).error, hint });
    });

    socket.once('connect', () => {
      // Дальше временем распоряжается ssh2: свой таймаут снимаем, иначе он
      // оборвёт уже установленное соединение посреди рукопожатия.
      socket.setTimeout(0);
      try {
        conn.connect({
          sock: socket,
          username: secrets.username,
          privateKey: secrets.privateKey,
          passphrase: secrets.passphrase || undefined,
          readyTimeout: cfg.connect_timeout_ms,
          hostVerifier,
        });
      } catch (err) {
        done({ ok: false, error: classifyConnectionError(err).error, hint });
      } finally {
        // Ключ уже у клиента ssh2; держать копию в памяти дольше незачем.
        if (Buffer.isBuffer(secrets.privateKey)) secrets.privateKey.fill(0);
        secrets.passphrase = null;
      }
    });
  });
}

module.exports = { testConnection, loopbackHint };
