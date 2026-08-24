/**
 * Прокрутка терминала пальцем.
 *
 * В xterm.js 6 виден только текущий экран: слой `.xterm-viewport` ровно
 * той же высоты, что и содержимое (scrollHeight === clientHeight), а
 * полоса прокрутки синтетическая — та же, что в VS Code. Нативной
 * прокрутки, которую браузер подхватил бы сам, там нет, а обработчик
 * касаний в сборке хоть и лежит, но ни к чему не подключён: `addTarget`
 * не вызывается ни разу. Колесо мыши работает, палец — нет.
 *
 * Поэтому жест разбирается здесь и переводится в `scrollLines` — это
 * публичный метод, и он не зависит от того, чем xterm рисует полосу.
 */

/** Ниже этого сдвига жест считается тапом, а не протяжкой. */
const DRAG_THRESHOLD_PX = 8;

/** Скорость, ниже которой инерцию не запускаем. */
const MIN_FLING_VELOCITY = 0.05;

/** Затухание броска за кадр: подобрано на глаз под ~60 Гц. */
const FRICTION = 0.95;

/** Прекращаем инерцию, когда осталось меньше этого за кадр. */
const MIN_FLING_STEP = 0.02;

/**
 * @param {import('@xterm/xterm').Terminal} term
 * @param {HTMLElement} element контейнер терминала
 */
export function initTouchScroll(term, element) {
  let active = false;
  let startY = 0;
  let lastY = 0;
  let lastAt = 0;
  let velocity = 0;
  let carry = 0;
  let dragging = false;
  let flingFrame = null;

  /** Высота строки в пикселях — из фактических размеров, а не из настроек. */
  function rowHeight() {
    const rows = element.querySelector('.xterm-rows');
    const first = rows && rows.firstElementChild;
    const measured = first ? first.getBoundingClientRect().height : 0;
    if (measured > 0) return measured;
    // Запасной путь: до первой отрисовки строк ещё нет.
    const screen = element.querySelector('.xterm-screen');
    if (screen && term.rows > 0) return screen.getBoundingClientRect().height / term.rows;
    return 17;
  }

  /**
   * Пиксели переводим в строки с переносом остатка: без него медленное
   * движение пальцем не набирает целой строки и не прокручивает вовсе,
   * а быстрое теряет до строки на каждом событии.
   */
  function scrollByPixels(dy) {
    const step = rowHeight();
    if (step <= 0) return;
    carry += dy / step;
    const lines = Math.trunc(carry);
    if (lines === 0) return;
    carry -= lines;
    term.scrollLines(lines);
  }

  function stopFling() {
    if (flingFrame !== null) cancelAnimationFrame(flingFrame);
    flingFrame = null;
  }

  /** Бросок: пролистываем по инерции, пока скорость не затухнет. */
  function startFling() {
    if (Math.abs(velocity) < MIN_FLING_VELOCITY) return;
    const step = rowHeight();
    const tick = () => {
      velocity *= FRICTION;
      if (Math.abs(velocity) < MIN_FLING_STEP) {
        flingFrame = null;
        return;
      }
      // velocity в пикселях за миллисекунду; за кадр — примерно 16 мс.
      scrollByPixels(-velocity * 16);
      if (step <= 0) return;
      flingFrame = requestAnimationFrame(tick);
    };
    flingFrame = requestAnimationFrame(tick);
  }

  element.addEventListener(
    'touchstart',
    (event) => {
      // Двумя пальцами — это масштаб или системный жест, не наше дело.
      if (event.touches.length !== 1) {
        active = false;
        return;
      }
      // Касание по перекрытию (обрыв связи, ошибка) — там своя кнопка.
      if (event.target.closest('.overlay')) {
        active = false;
        return;
      }
      stopFling();
      active = true;
      dragging = false;
      carry = 0;
      velocity = 0;
      startY = event.touches[0].clientY;
      lastY = startY;
      lastAt = event.timeStamp;
    },
    { passive: true }
  );

  element.addEventListener(
    'touchmove',
    (event) => {
      if (!active || event.touches.length !== 1) return;

      const y = event.touches[0].clientY;
      const fromStart = y - startY;

      if (!dragging) {
        if (Math.abs(fromStart) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        // Отсчёт ведём от порога, иначе первый шаг прыгает на его величину.
        lastY = y;
        lastAt = event.timeStamp;
      }

      const dy = y - lastY;
      const dt = event.timeStamp - lastAt;
      if (dt > 0) velocity = dy / dt;
      lastY = y;
      lastAt = event.timeStamp;

      // Палец вниз — уезжаем в прошлое, то есть scrollLines с минусом.
      scrollByPixels(-dy);

      // Обязательно и только при настоящей протяжке: иначе браузер
      // потянет саму страницу, а тап перестанет ставить курсор.
      event.preventDefault();
    },
    { passive: false }
  );

  const finish = () => {
    if (active && dragging) startFling();
    active = false;
    dragging = false;
  };

  element.addEventListener('touchend', finish, { passive: true });
  element.addEventListener('touchcancel', finish, { passive: true });
}
