/**
 * Журнал вывода для скачивания.
 *
 * Хранится в памяти вкладки и никуда не отправляется: серверная запись
 * сессий неминуемо захватила бы то, что человек набирает в приглашениях
 * sudo и ssh, то есть превратила бы хранилище в склад чужих паролей.
 *
 * Буфер кольцевой: длинная сессия иначе съедает память вкладки.
 */

const MAX_CHARS = 2 * 1024 * 1024;

// Именно escape-последовательность для RegExp, а не сам символ: живой
// управляющий байт в исходнике невидим и легко теряется при правках.
const ESC = '\\u001b';

/** Управляющие последовательности: в текстовом файле это просто мусор. */
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const OSC_SEQUENCE = new RegExp(`${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\)`, 'g');
const SHORT_ESCAPE = new RegExp(`${ESC}[@-Z\\\\-_]`, 'g');

export class SessionLog {
  constructor({ maxChars = MAX_CHARS } = {}) {
    this.maxChars = maxChars;
    this.text = '';
    this.truncated = false;
    // stream: true придерживает незавершённую последовательность UTF-8 до
    // следующей порции — без этого разрезанный границей символ превратился
    // бы в U+FFFD прямо в журнале.
    this.decoder = new TextDecoder('utf-8');
  }

  append(bytes) {
    this.text += this.decoder.decode(bytes, { stream: true });
    if (this.text.length > this.maxChars) {
      this.text = this.text.slice(this.text.length - this.maxChars);
      this.truncated = true;
    }
  }

  clear() {
    this.text = '';
    this.truncated = false;
  }

  get isEmpty() {
    return this.text.length === 0;
  }

  toPlainText() {
    const header = this.truncated
      ? `${t('term.logTruncated', { count: this.maxChars })}\n\n`
      : '';

    const cleaned = this.text
      .replace(CSI_SEQUENCE, '')
      .replace(OSC_SEQUENCE, '')
      .replace(SHORT_ESCAPE, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

    return header + cleaned;
  }

  download() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([this.toPlainText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = `webssh-${stamp}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    // Освобождаем сразу после клика: держать объект дольше незачем.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
