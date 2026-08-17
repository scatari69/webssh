/**
 * Контекстное меню терминала.
 *
 * Один компонент на два способа вызова: правый клик мышью и долгий тап
 * пальцем. Меню не полагается на точное попадание — тач-таргеты не меньше
 * 44px, а позиция зажимается в границы экрана, чтобы у нижнего края оно
 * раскрывалось вверх, а не за пределы видимой области.
 */

const LONG_PRESS_MS = 500;
/** Сдвиг пальца больше этого — человек прокручивает, а не удерживает. */
const MOVE_TOLERANCE_PX = 10;
const EDGE_GAP_PX = 8;

export class ContextMenu {
  /**
   * @param {HTMLElement} root контейнер меню
   * @param {() => Array} buildItems возвращает описание пунктов при открытии
   */
  constructor(root, buildItems) {
    this.root = root;
    this.buildItems = buildItems;
    this.open = false;

    document.addEventListener('pointerdown', (event) => {
      if (this.open && !this.root.contains(event.target)) this.hide();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.open) {
        event.preventDefault();
        this.hide();
      }
    });

    window.addEventListener('blur', () => this.hide());
    window.addEventListener('resize', () => this.hide());
  }

  /**
   * Открывает меню у точки вызова, разворачивая его вверх или влево, если
   * иначе оно вылезет за край.
   */
  show(x, y) {
    this.render();
    this.root.hidden = false;

    // Размеры известны только после вставки в поток.
    const { offsetWidth: width, offsetHeight: height } = this.root;
    const maxX = window.innerWidth - width - EDGE_GAP_PX;
    const maxY = window.innerHeight - height - EDGE_GAP_PX;

    this.root.style.left = `${Math.max(EDGE_GAP_PX, Math.min(x, maxX))}px`;
    this.root.style.top = `${Math.max(EDGE_GAP_PX, Math.min(y, maxY))}px`;

    this.open = true;

    const first = this.root.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }

  hide() {
    if (!this.open) return;
    this.root.hidden = true;
    this.open = false;
  }

  render() {
    const nodes = [];

    for (const item of this.buildItems()) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'menu-separator';
        nodes.push(sep);
        continue;
      }

      if (item.type === 'label') {
        const label = document.createElement('div');
        label.className = 'menu-label';
        label.textContent = item.text;
        nodes.push(label);
        continue;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';
      button.setAttribute('role', 'menuitem');
      button.disabled = Boolean(item.disabled);

      const text = document.createElement('span');
      text.textContent = item.text;
      button.appendChild(text);

      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'menu-item-hint';
        hint.textContent = item.hint;
        button.appendChild(hint);
      }

      if (item.checked !== undefined) {
        button.setAttribute('aria-checked', String(item.checked));
        button.setAttribute('role', 'menuitemradio');
      }

      button.addEventListener('click', () => {
        // Пункты вроде «крупнее/мельче» и переключения языка нажимают
        // подряд по нескольку раз. Закрывать меню после каждого нажатия
        // значило бы заставлять открывать его заново на каждый шаг.
        if (item.keepOpen) {
          const index = nodes.indexOf(button);
          item.action();
          this.render();
          // После перерисовки узлы другие — возвращаем фокус на то же
          // место, иначе клавиатурная навигация сбрасывается в начало.
          const refreshed = this.root.children[index];
          if (refreshed instanceof HTMLButtonElement && !refreshed.disabled) refreshed.focus();
          return;
        }
        this.hide();
        item.action();
      });

      nodes.push(button);
    }

    this.root.replaceChildren(...nodes);
  }

  /**
   * Вешает оба способа вызова на элемент терминала.
   */
  attachTo(element) {
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.show(event.clientX, event.clientY);
    });

    let timer = null;
    let startX = 0;
    let startY = 0;

    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    element.addEventListener(
      'pointerdown',
      (event) => {
        // Долгий тап — только для пальца: у мыши есть правая кнопка,
        // а у стилуса своё поведение.
        if (event.pointerType !== 'touch') return;
        startX = event.clientX;
        startY = event.clientY;
        cancel();
        timer = setTimeout(() => {
          timer = null;
          this.show(startX, startY);
        }, LONG_PRESS_MS);
      },
      { passive: true }
    );

    element.addEventListener(
      'pointermove',
      (event) => {
        if (!timer) return;
        if (
          Math.abs(event.clientX - startX) > MOVE_TOLERANCE_PX ||
          Math.abs(event.clientY - startY) > MOVE_TOLERANCE_PX
        ) {
          cancel();
        }
      },
      { passive: true }
    );

    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      element.addEventListener(type, cancel, { passive: true });
    }

    // iOS показывает собственное всплывающее меню поверх нашего.
    element.style.webkitTouchCallout = 'none';
  }
}
