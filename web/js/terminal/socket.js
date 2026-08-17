/**
 * Соединение с /ws/terminal: отправка ввода и размеров, приём байтов PTY
 * и управляющих сообщений, переподключение с растущей задержкой.
 */

/**
 * Коды, после которых переподключаться бессмысленно: они требуют действия
 * человека — войти заново, дождаться администратора, освободить сессию.
 * Долбиться в закрытую дверь по таймеру значит только жечь батарею.
 */
const FATAL_CLOSE_CODES = new Set([
  4401, // не аутентифицирован
  4403, // учётка отключена или сессия отозвана
  4404, // SSH-хост не настроен
  4408, // закрыто из-за простоя
  4409, // достигнут предел одновременных сессий
  4410, // ключ хоста не совпал
  4413, // кадр больше разрешённого
  1009, // то же самое, но закрытие пришло от библиотеки ws раньше нашего
]);

/**
 * Причины, о которых сервер может не успеть сообщить отдельным сообщением:
 * кадр сверх лимита рвёт соединение до того, как уйдёт текст ошибки. Тогда
 * единственное, что доезжает до клиента, — код закрытия, и смысл ему
 * приходится возвращать здесь.
 */
const CLOSE_CODE_ERRORS = {
  4413: {
    error: 'message_too_large',
    message: 'Отправленный фрагмент слишком велик — соединение закрыто. Вставляйте текст меньшими частями.',
  },
  1009: {
    error: 'message_too_large',
    message: 'Отправленный фрагмент слишком велик — соединение закрыто. Вставляйте текст меньшими частями.',
  },
};

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

function socketUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/ws/terminal`;
}

export class TerminalSocket {
  /**
   * @param {object} handlers
   * @param {(bytes: Uint8Array) => void} handlers.onBytes вывод PTY как есть
   * @param {(message: object) => void} handlers.onMessage управляющее сообщение
   * @param {(state: object) => void} handlers.onState изменение состояния связи
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.attempt = 0;
    this.retryTimer = null;
    this.countdownTimer = null;
    this.pendingSize = null;
    this.manualClose = false;
    this.lastError = null;
  }

  connect() {
    this.clearTimers();
    this.manualClose = false;
    this.handlers.onState({ state: 'connecting' });

    const ws = new WebSocket(socketUrl());
    // Байты вывода приходят двоичными кадрами; ArrayBuffer отдаём в xterm
    // без промежуточного декодирования — он сам разбирает UTF-8 и корректно
    // склеивает символы, разрезанные границей порции.
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.lastError = null;
      if (this.pendingSize) this.resize(this.pendingSize.cols, this.pendingSize.rows);
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'error') this.lastError = message;
        this.handlers.onMessage(message);
        return;
      }
      this.handlers.onBytes(new Uint8Array(event.data));
    };

    ws.onerror = () => {
      // Подробностей браузер не даёт; всё существенное придёт в onclose.
    };

    ws.onclose = (event) => {
      this.ws = null;
      if (this.manualClose) {
        this.handlers.onState({ state: 'closed', manual: true });
        return;
      }

      // Штатное закрытие сервером означает, что шелл завершился сам:
      // человек набрал exit. Молча открывать ему новую сессию не нужно —
      // предлагаем сделать это кнопкой.
      if (event.code === 1000) {
        this.handlers.onState({ state: 'closed', code: event.code });
        return;
      }

      const fatal = FATAL_CLOSE_CODES.has(event.code);
      this.handlers.onState({
        state: fatal ? 'error' : 'reconnecting',
        code: event.code,
        reason: event.reason,
        error: this.lastError || CLOSE_CODE_ERRORS[event.code] || null,
        fatal,
      });

      if (!fatal) this.scheduleReconnect();
    };
  }

  /**
   * Задержка растёт вдвое с каждой попыткой и размывается случайной
   * добавкой: без неё все вкладки и все клиенты, оборвавшиеся из-за одной
   * сетевой аварии, ломились бы обратно ровно в один момент.
   */
  scheduleReconnect() {
    this.attempt += 1;
    const base = Math.min(BASE_DELAY_MS * 2 ** (this.attempt - 1), MAX_DELAY_MS);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));

    let remaining = Math.ceil(delay / 1000);
    this.handlers.onState({ state: 'reconnecting', retryInSeconds: remaining, attempt: this.attempt });

    this.countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        this.handlers.onState({ state: 'reconnecting', retryInSeconds: remaining, attempt: this.attempt });
      }
    }, 1000);

    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Немедленная попытка — по кнопке или при возвращении вкладки в фокус. */
  retryNow() {
    if (this.isOpen()) return;
    this.attempt = 0;
    this.connect();
  }

  clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.retryTimer = null;
    this.countdownTimer = null;
  }

  isOpen() {
    return Boolean(this.ws) && this.ws.readyState === WebSocket.OPEN;
  }

  send(payload) {
    if (!this.isOpen()) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  write(data) {
    return this.send({ type: 'data', data });
  }

  resize(cols, rows) {
    // Размеры, не дошедшие до сервера, запоминаем: их нужно отправить сразу
    // после подключения, иначе PTY откроется с чужим размером.
    this.pendingSize = { cols, rows };
    return this.send({ type: 'resize', cols, rows });
  }

  close() {
    this.manualClose = true;
    this.clearTimers();
    if (this.ws) this.ws.close(1000, 'client');
  }
}
