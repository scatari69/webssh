/**
 * Привязка высоты приложения к реально видимой области.
 *
 * `100vh` на мобильном врёт: он не учитывает ни сворачивающуюся адресную
 * строку, ни виртуальную клавиатуру — терминал уезжает под них. Настоящий
 * размер даёт только visualViewport, поэтому высота и вертикальное
 * смещение попадают в CSS-переменные, а вёрстка опирается на них.
 */

const root = document.documentElement;

function currentMetrics() {
  const vv = window.visualViewport;
  if (!vv) return { height: window.innerHeight, top: 0 };
  return { height: vv.height, top: vv.offsetTop };
}

export function initViewport(onChange, { debounceMs = 80 } = {}) {
  let timer = null;
  let lastHeight = 0;

  const apply = () => {
    const { height, top } = currentMetrics();
    root.style.setProperty('--app-height', `${Math.round(height)}px`);
    root.style.setProperty('--app-top', `${Math.round(top)}px`);

    const keyboardOpen = height < lastHeight - 80;
    lastHeight = height;
    onChange({ height, top, keyboardOpen });
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, debounceMs);
  };

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', schedule);
    // Прокрутка визуальной области меняет смещение — при открытой
    // клавиатуре без этого панель клавиш уползает за край.
    vv.addEventListener('scroll', schedule);
  }
  window.addEventListener('resize', schedule);

  window.addEventListener('orientationchange', () => {
    // Поворот экрана: размеры устаканиваются не мгновенно, поэтому
    // пересчитываем и сразу, и чуть погодя.
    apply();
    setTimeout(apply, 250);
  });

  const { height } = currentMetrics();
  lastHeight = height;
  apply();

  return { refresh: apply };
}
