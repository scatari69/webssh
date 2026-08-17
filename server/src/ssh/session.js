'use strict';

const crypto = require('node:crypto');

const { Client } = require('ssh2');

const config = require('../config');
const audit = require('../services/audit');
const { CLOSE, failAndClose, parseClientMessage, sendData, sendJson } = require('../ws/protocol');
const configStore = require('./configStore');
const { createHostVerifier } = require('./hostKey');

const TERM = 'xterm-256color';
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Пороги обратного давления. Мобильный клиент на плохой связи читает
 * медленнее, чем `cat` на хосте пишет; без паузы весь непрочитанный вывод
 * копился бы в памяти процесса.
 */
const BUFFER_HIGH_WATER = 1024 * 1024;
const BUFFER_LOW_WATER = 256 * 1024;

/**
 * Сообщения ssh2 — для человека, а не для машины, поэтому сопоставляем их
 * с кодами сами. Наружу уходит и код, и понятный текст: администратору
 * нужно понимать, чинить ключ, сеть или конфигурацию.
 */
function classifyConnectionError(err) {
  const message = String((err && err.message) || '');
  const code = (err && err.code) || '';
  const level = (err && err.level) || '';

  if (level === 'client-authentication' || /All configured authentication methods failed/i.test(message)) {
    return {
      error: 'ssh_auth_failed',
      message: 'Хост отверг ключ. Проверьте SSH-логин и приватный ключ в настройках.',
    };
  }
  if (code === 'ECONNREFUSED') {
    return { error: 'ssh_connection_refused', message: 'Хост отклонил подключение: порт закрыт или сервис не запущен.' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { error: 'ssh_host_unresolved', message: 'Не удалось разрешить имя хоста.' };
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { error: 'ssh_host_unreachable', message: 'Хост недоступен по сети.' };
  }
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(message)) {
    return { error: 'ssh_timeout', message: 'Истекло время ожидания ответа от хоста.' };
  }
  if (/host key/i.test(message) || /handshake/i.test(message)) {
    return { error: 'ssh_handshake_failed', message: 'Не удалось согласовать соединение с хостом.' };
  }
  return { error: 'ssh_error', message: 'Не удалось установить SSH-соединение.' };
}

class TerminalSession {
  constructor({ ws, user, ip, userAgent }) {
    this.id = crypto.randomUUID();
    this.ws = ws;
    this.user = user;
    this.ip = ip;
    this.userAgent = userAgent;

    this.conn = null;
    this.stream = null;
    this.closed = false;
    this.startedAt = Date.now();
    this.lastActivityAt = Date.now();
    this.bytesIn = 0;
    this.bytesOut = 0;

    // Размеры приходят отдельным сообщением и могут опередить готовность
    // SSH — тогда они просто ждут здесь.
    this.cols = DEFAULT_COLS;
    this.rows = DEFAULT_ROWS;

    this.onClosed = null;
  }

  audit(action, extra = {}) {
    audit.record({
      action,
      userId: this.user.id,
      actorUsername: this.user.username,
      targetType: 'terminal_session',
      targetId: this.id,
      terminalSessionId: this.id,
      ip: this.ip,
      userAgent: this.userAgent,
      ...extra,
    });
  }

  start() {
    const publicConfig = configStore.getPublic();

    // Первый запуск: администратор ещё не задал хост. Понятный отказ вместо
    // попытки подключиться в пустоту.
    if (!publicConfig.is_configured) {
      this.audit('terminal.rejected', { outcome: 'failure', detail: { reason: 'ssh_not_configured' } });
      failAndClose(
        this.ws,
        CLOSE.NOT_CONFIGURED,
        'ssh_not_configured',
        'SSH-хост ещё не настроен администратором.'
      );
      return;
    }

    let secrets;
    try {
      secrets = configStore.loadConnectionSecrets();
      if (!secrets) throw new Error('ssh_key_missing');
    } catch {
      this.audit('terminal.rejected', { outcome: 'failure', detail: { reason: 'ssh_key_unreadable' } });
      failAndClose(
        this.ws,
        CLOSE.NOT_CONFIGURED,
        'ssh_key_unreadable',
        'Не удалось прочитать приватный ключ. Загрузите его заново в админке.'
      );
      return;
    }

    this.attachClientHandlers();
    this.connect(secrets);
  }

  connect(secrets) {
    const cfg = configStore.rawRow();
    const conn = new Client();
    this.conn = conn;

    let hostKeyMismatch = null;

    const hostVerifier = createHostVerifier(cfg, {
      onMismatch: (info) => {
        hostKeyMismatch = info;
        audit.record({
          action: 'ssh_config.host_key_mismatch',
          outcome: 'failure',
          userId: this.user.id,
          actorUsername: this.user.username,
          targetType: 'ssh_config',
          targetId: 1,
          terminalSessionId: this.id,
          ip: this.ip,
          detail: { presented: info.presented, expected: info.expected },
        });
      },
      onLearn: (info) => {
        audit.record({
          action: 'ssh_config.host_key_learned',
          userId: this.user.id,
          actorUsername: this.user.username,
          targetType: 'ssh_config',
          targetId: 1,
          terminalSessionId: this.id,
          ip: this.ip,
          detail: { fingerprint: info.fingerprint },
        });
      },
    });

    conn.on('ready', () => this.openShell());

    conn.on('error', (err) => {
      if (hostKeyMismatch) {
        this.audit('terminal.rejected', {
          outcome: 'failure',
          detail: { reason: 'host_key_mismatch', presented: hostKeyMismatch.presented },
        });
        this.finish(
          CLOSE.HOST_KEY_MISMATCH,
          'ssh_host_key_mismatch',
          'Ключ хоста не совпадает с сохранённым. Подключение прервано — обратитесь к администратору.'
        );
        return;
      }

      const classified = classifyConnectionError(err);
      this.audit('terminal.rejected', {
        outcome: 'failure',
        detail: { reason: classified.error, code: err.code || null },
      });
      this.finish(CLOSE.SSH_ERROR, classified.error, classified.message);
    });

    conn.on('close', () => this.finish(CLOSE.NORMAL, null, null));

    try {
      conn.connect({
        host: secrets.host,
        port: secrets.port,
        username: secrets.username,
        privateKey: secrets.privateKey,
        passphrase: secrets.passphrase || undefined,
        readyTimeout: cfg.connect_timeout_ms,
        keepaliveInterval: cfg.keepalive_interval_ms,
        hostVerifier,
      });
    } catch (err) {
      const classified = classifyConnectionError(err);
      this.finish(CLOSE.SSH_ERROR, classified.error, classified.message);
    } finally {
      // Ключ уже передан клиенту ssh2; держать его копию в памяти дольше
      // необходимого незачем.
      if (Buffer.isBuffer(secrets.privateKey)) secrets.privateKey.fill(0);
      secrets.passphrase = null;
    }
  }

  openShell() {
    this.conn.shell({ term: TERM, cols: this.cols, rows: this.rows }, (err, stream) => {
      if (err) {
        this.audit('terminal.rejected', { outcome: 'failure', detail: { reason: 'pty_failed' } });
        this.finish(CLOSE.SSH_ERROR, 'ssh_pty_failed', 'Хост не выдал терминал (PTY).');
        return;
      }

      this.stream = stream;

      const forward = (chunk) => {
        this.bytesOut += chunk.length;
        sendData(this.ws, chunk, () => {
          if (this.stream && this.stream.isPaused() && this.ws.bufferedAmount < BUFFER_LOW_WATER) {
            this.stream.resume();
          }
        });
        if (this.ws.bufferedAmount > BUFFER_HIGH_WATER) stream.pause();
      };

      stream.on('data', forward);
      // stderr отдельным каналом, но на экране это один поток — как в
      // обычном терминале.
      stream.stderr.on('data', forward);

      stream.on('close', () => this.finish(CLOSE.NORMAL, null, null));

      stream.on('exit', (code, signal) => {
        sendJson(this.ws, { type: 'exit', code: code ?? null, signal: signal ?? null });
      });

      this.audit('terminal.open', {
        detail: {
          host: configStore.getPublic().host,
          ssh_username: configStore.getPublic().ssh_username,
          cols: this.cols,
          rows: this.rows,
        },
      });

      sendJson(this.ws, {
        type: 'ready',
        session_id: this.id,
        cols: this.cols,
        rows: this.rows,
      });
    });
  }

  attachClientHandlers() {
    this.ws.on('message', (raw, isBinary) => {
      this.lastActivityAt = Date.now();
      const message = parseClientMessage(raw, isBinary);

      switch (message.type) {
        case 'data':
          this.bytesIn += message.data.length;
          // До готовности PTY ввод отбрасывается: складывать его некуда, а
          // «проиграть» его позже означало бы отправить команды вслепую.
          if (this.stream) this.stream.write(message.data);
          break;

        case 'resize':
          this.cols = message.cols;
          this.rows = message.rows;
          if (this.stream) this.stream.setWindow(this.rows, this.cols, 0, 0);
          break;

        case 'ping':
          sendJson(this.ws, { type: 'pong' });
          break;

        case 'error':
          sendJson(this.ws, { type: 'error', error: message.error, message: 'Некорректное сообщение.' });
          break;

        default:
          break;
      }
    });

    this.ws.on('close', () => this.finish(CLOSE.NORMAL, null, null));
    this.ws.on('error', () => this.finish(CLOSE.NORMAL, null, null));
  }

  isIdle(now = Date.now()) {
    return now - this.lastActivityAt > config.limits.idleTimeoutMs;
  }

  /** Закрытие по инициативе сервера: лимит простоя, деактивация, остановка. */
  terminate(code, error, message) {
    this.finish(code, error, message);
  }

  /**
   * Единая точка завершения. Вызывается и при обрыве WebSocket, и при
   * закрытии SSH, поэтому защищена флагом: обе стороны сообщают о закрытии,
   * а запись в журнал должна быть одна.
   */
  finish(code, error, message) {
    if (this.closed) return;
    this.closed = true;

    if (error) {
      sendJson(this.ws, { type: 'error', error, message });
    }

    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        // Поток мог быть уже разрушен другой стороной.
      }
    }
    if (this.conn) {
      try {
        this.conn.end();
      } catch {
        // То же самое: соединение могло закрыться само.
      }
    }

    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      try {
        this.ws.close(code, error || 'closed');
      } catch {
        // Кадр закрытия — лучшее усилие, не повод падать.
      }
    }

    // Содержимого терминала в журнале нет и быть не должно: там пароли,
    // которые человек набирает в приглашениях sudo и ssh. Только объём.
    //
    // Сбой записи не должен срывать закрытие: этот метод вызывается из
    // обработчиков событий сокета, и выброшенное отсюда исключение
    // оставило бы SSH-соединение висеть, а то и уронило бы процесс.
    try {
      this.audit('terminal.close', {
        outcome: error ? 'failure' : 'success',
        detail: {
          duration_ms: Date.now() - this.startedAt,
          bytes_in: this.bytesIn,
          bytes_out: this.bytesOut,
          reason: error || 'closed',
        },
      });
    } catch (err) {
      console.error('[terminal] не удалось записать закрытие сессии в журнал:', err.message);
    }

    if (this.onClosed) this.onClosed(this);
  }
}

module.exports = { TerminalSession, classifyConnectionError, TERM };
