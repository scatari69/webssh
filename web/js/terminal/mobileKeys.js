/**
 * Панель специальных клавиш для мобильной клавиатуры.
 *
 * На системной клавиатуре нет ни Esc, ни Tab, ни Ctrl, ни стрелок — без
 * них в терминале нельзя ни выйти из vim, ни дополнить путь, ни прервать
 * команду. Панель живёт над клавиатурой: её положение обеспечивает
 * привязка корня приложения к visualViewport (см. viewport.js).
 */

/** Ctrl+<буква> — это управляющий символ с кодом буквы минус 64. */
function controlCode(key) {
  const upper = key.toUpperCase();
  if (upper.length !== 1) return null;
  const code = upper.charCodeAt(0);
  if (code < 64 || code > 95) return null;
  return String.fromCharCode(code - 64);
}

const KEYS = [
  { label: 'Esc', send: '\x1b' },
  { label: 'Tab', send: '\t' },
  { label: 'Ctrl', modifier: true },
  { label: '↑', send: '\x1b[A' },
  { label: '↓', send: '\x1b[B' },
  { label: '←', send: '\x1b[D' },
  { label: '→', send: '\x1b[C' },
  { label: '^C', send: '\x03' },
  { label: '^D', send: '\x04' },
  { label: '^Z', send: '\x1a' },
  { label: '^L', send: '\x0c' },
  { label: 'Home', send: '\x1b[H' },
  { label: 'End', send: '\x1b[F' },
  { label: '|', send: '|' },
  { label: '~', send: '~' },
  { label: '/', send: '/' },
];

export class MobileKeys {
  /**
   * @param {HTMLElement} root
   * @param {{ send: (data: string) => void, focusTerminal: () => void }} deps
   */
  constructor(root, { send, focusTerminal }) {
    this.root = root;
    this.send = send;
    this.focusTerminal = focusTerminal;
    this.ctrlActive = false;
    this.ctrlButton = null;

    this.render();
  }

  render() {
    const nodes = KEYS.map((key) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'keybar-key';
      button.textContent = key.label;

      if (key.modifier) {
        button.setAttribute('aria-pressed', 'false');
        this.ctrlButton = button;
      }

      // pointerdown, а не click: нажатие кнопки не должно уводить фокус с
      // терминала, иначе системная клавиатура закрывается на каждом тапе.
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        if (key.modifier) this.toggleCtrl();
        else this.press(key.send);
      });

      return button;
    });

    this.root.replaceChildren(...nodes);
  }

  toggleCtrl() {
    this.ctrlActive = !this.ctrlActive;
    if (this.ctrlButton) this.ctrlButton.setAttribute('aria-pressed', String(this.ctrlActive));
    this.focusTerminal();
  }

  press(data) {
    // Ctrl залипающий: он действует ровно на одну следующую клавишу и
    // затем сам снимается — как Shift на телефонной клавиатуре.
    if (this.ctrlActive && data.length === 1) {
      const control = controlCode(data);
      this.send(control === null ? data : control);
      this.toggleCtrl();
    } else {
      this.send(data);
      if (this.ctrlActive) this.toggleCtrl();
    }
    this.focusTerminal();
  }

  /**
   * Ctrl применяется и к обычным буквам, набранным на системной
   * клавиатуре, — иначе модификатор работал бы только с кнопками панели.
   * @returns {string|null} что отправить вместо исходного ввода
   */
  transformInput(data) {
    if (!this.ctrlActive) return null;
    const control = controlCode(data);
    this.toggleCtrl();
    return control === null ? data : control;
  }
}

export { controlCode };
