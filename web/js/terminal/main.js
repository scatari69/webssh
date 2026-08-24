import { FitAddon } from '/vendor/addon-fit.mjs';
import { SearchAddon } from '/vendor/addon-search.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { Terminal } from '/vendor/xterm.mjs';

import { api } from '../common/api.js';
import { FLAVOR_IDS, FLAVORS } from '../common/catppuccin.js';
import {
  LANGS,
  LANG_IDS,
  applyStatic,
  getLang,
  initI18n,
  onLangChange,
  setLang,
  t,
} from '../common/i18n.js';
import { getTheme, initTheme, onThemeChange, setTheme, toXtermTheme } from '../common/theme.js';
import { ContextMenu } from './contextMenu.js';
import {
  canGrow,
  canShrink,
  getFontSize,
  initFontSize,
  onFontSizeChange,
  stepFontSize,
} from './fontSize.js';
import { MobileKeys } from './mobileKeys.js';
import { SessionLog } from './sessionLog.js';
import { TerminalSocket } from './socket.js';
import { initViewport } from './viewport.js';

initTheme();
initI18n();
applyStatic();

const el = (id) => document.getElementById(id);

const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
document.body.dataset.touch = String(isTouch);

/* ------------------------------------------------------------ терминал */

const term = new Terminal({
  theme: toXtermTheme(getTheme()),
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSize: initFontSize(isTouch),
  lineHeight: 1.15,
  cursorBlink: true,
  scrollback: 5000,
  // На касании курсор ставится тапом, а выделение делается долгим
  // нажатием системного механизма — свой обработчик правой кнопки здесь
  // не нужен.
  rightClickSelectsWord: !isTouch,
  allowProposedApi: true,
});

const fitAddon = new FitAddon();
const searchAddon = new SearchAddon();
term.loadAddon(fitAddon);
term.loadAddon(searchAddon);
term.loadAddon(
  new WebLinksAddon((event, uri) => {
    // Ссылку открываем только осознанным щелчком, а не случайным
    // касанием при прокрутке.
    if (event.type === 'click') window.open(uri, '_blank', 'noopener,noreferrer');
  })
);

term.open(el('terminal-host'));

const sessionLog = new SessionLog();

/* -------------------------------------------------------------- статус */

const statusEl = el('status');
const statusTextEl = el('status-text');
const overlayEl = el('overlay');
const overlayTitleEl = el('overlay-title');
const overlayMessageEl = el('overlay-message');
const overlayActionEl = el('overlay-action');

/*
 * Статус и перекрытие задаются ключами перевода, а не готовым текстом:
 * иначе при смене языка на экране остался бы прежний, и «Подключено» жило
 * бы по-русски до следующего события сокета.
 */
let status = null;
let overlay = null;

function renderStatus() {
  if (!status) return;
  statusEl.dataset.state = status.state;
  statusTextEl.textContent = t(status.key, status.vars);
}

function setStatus(state, key, vars) {
  status = { state, key, vars };
  renderStatus();
}

function renderOverlay() {
  if (!overlay) return;

  overlayEl.dataset.kind = overlay.kind;
  overlayTitleEl.textContent = t(overlay.titleKey, overlay.vars);
  overlayMessageEl.textContent = overlay.messageKey ? t(overlay.messageKey, overlay.vars) : '';

  if (overlay.actionKey) {
    overlayActionEl.textContent = t(overlay.actionKey);
    overlayActionEl.onclick = overlay.onAction;
    overlayActionEl.classList.remove('hidden');
  } else {
    overlayActionEl.classList.add('hidden');
    overlayActionEl.onclick = null;
  }

  overlayEl.classList.remove('hidden');
}

function showOverlay(spec) {
  overlay = { kind: 'info', ...spec };
  renderOverlay();
}

function hideOverlay() {
  overlay = null;
  overlayEl.classList.add('hidden');
}

function showToast(text) {
  const toast = el('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

/* ------------------------------------------------------------- сокет */

let lastError = null;

/**
 * Текст ошибки берётся по коду из словаря, а не из поля message ответа:
 * сервер не знает выбранного языка. Серверная строка остаётся запасной для
 * кодов, которых в словаре ещё нет.
 */
function errorMessage(error, fallbackKey) {
  if (!error) return fallbackKey ? t(fallbackKey) : '';
  const key = `err.${error.error}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return error.message || (fallbackKey ? t(fallbackKey) : '');
}

const socket = new TerminalSocket({
  onBytes(bytes) {
    // Байты уходят в xterm как есть: он сам разбирает UTF-8 и склеивает
    // символы, разрезанные границей порции.
    term.write(bytes);
    sessionLog.append(bytes);
  },

  onMessage(message) {
    switch (message.type) {
      case 'ready':
        lastError = null;
        hideOverlay();
        setStatus('connected', 'term.statusConnected');
        term.focus();
        break;

      case 'error':
        lastError = message;
        break;

      case 'exit':
        setStatus('closed', 'term.statusClosed');
        break;

      default:
        break;
    }
  },

  onState(state) {
    switch (state.state) {
      case 'connecting':
        setStatus('connecting', 'term.statusConnecting');
        showOverlay({ titleKey: 'term.connectingTitle', messageKey: 'term.connectingMessage' });
        break;

      case 'reconnecting': {
        if (state.retryInSeconds === undefined) {
          setStatus('reconnecting', 'term.statusDropped');
          break;
        }
        setStatus('reconnecting', 'term.statusRetryIn', { seconds: state.retryInSeconds });
        showOverlay({
          kind: 'info',
          titleKey: 'term.droppedTitle',
          messageKey: 'term.retryIn',
          vars: { seconds: state.retryInSeconds },
          actionKey: 'term.retryNow',
          onAction: () => socket.retryNow(),
        });
        break;
      }

      case 'closed':
        setStatus('closed', 'term.statusClosed');
        showOverlay({
          titleKey: 'term.closedTitle',
          messageKey: 'term.closedMessage',
          actionKey: 'term.reopen',
          onAction: () => socket.retryNow(),
        });
        break;

      case 'error':
        handleFatal(state);
        break;

      default:
        break;
    }
  },
});

function handleFatal(state) {
  const error = state.error || lastError;
  const code = error ? error.error : null;

  statusEl.dataset.state = 'error';
  statusTextEl.textContent = errorMessage(error, 'term.statusError');
  // Статус здесь уже переведён и хранится строкой: код ошибки может
  // прийти незнакомый, и тогда показывается то, что прислал сервер.
  status = null;

  // Сессия недействительна — дальше только через форму входа.
  if (state.code === 4401 || state.code === 4403) {
    overlay = {
      kind: 'error',
      titleKey: 'term.loginRequiredTitle',
      messageKey: 'term.loginRequiredMessage',
      actionKey: 'term.goToLogin',
      onAction: () => window.location.assign('/login'),
    };
    renderOverlay();
    setTimeout(() => window.location.assign('/login'), 2500);
    return;
  }

  const titleKey = `errTitle.${code}`;
  overlayEl.dataset.kind = 'error';
  overlayTitleEl.textContent = t(titleKey) === titleKey ? t('term.failedTitle') : t(titleKey);
  overlayMessageEl.textContent = errorMessage(error, 'term.failedMessage');
  overlayActionEl.textContent = t('term.retry');
  overlayActionEl.onclick = () => socket.retryNow();
  overlayActionEl.classList.remove('hidden');
  overlayEl.classList.remove('hidden');
  overlay = null;
}

/* ------------------------------------------------- ввод и размеры */

const mobileKeys = new MobileKeys(el('keybar'), {
  send: (data) => socket.write(data),
  focusTerminal: () => term.focus(),
});

term.onData((data) => {
  // Залипающий Ctrl должен действовать и на буквы с системной клавиатуры.
  const transformed = mobileKeys.transformInput(data);
  socket.write(transformed === null ? data : transformed);
});

term.onResize(({ cols, rows }) => socket.resize(cols, rows));

function fitTerminal() {
  try {
    fitAddon.fit();
  } catch {
    // Пока элемент скрыт или имеет нулевой размер, подгонять нечего.
  }
}

initViewport(() => {
  fitTerminal();
  // Размер мог не измениться — тогда onResize не сработает, и сервер
  // останется со старым значением. Отправляем текущее явно.
  socket.resize(term.cols, term.rows);
});

// Тап по терминалу отдаёт фокус служебному полю ввода xterm — именно оно
// открывает системную клавиатуру на мобильном.
el('terminal-wrap').addEventListener('pointerdown', (event) => {
  if (event.target.closest('.overlay')) return;
  term.focus();
});

// Возврат вкладки: мобильный браузер мог усыпить сокет.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.isOpen()) socket.retryNow();
});

/* -------------------------------------------------- размер шрифта */

/*
 * Смена размера меняет и число колонок, поэтому за ней обязана следовать
 * подгонка и отправка новых размеров на хост: иначе программы на той
 * стороне продолжат рисовать по старой ширине.
 */
onFontSizeChange((size) => {
  term.options.fontSize = size;
  fitTerminal();
  socket.resize(term.cols, term.rows);
});

function changeFontSize(delta) {
  const before = getFontSize();
  const after = stepFontSize(delta);
  if (after !== before) showToast(t('toast.fontSize', { size: after }));
}

/**
 * Сочетание распознаётся здесь, а не в общем обработчике на document:
 * когда фокус в терминале, событие до document просто не доходит — xterm
 * забирает его себе на своём служебном поле ввода. Возврат false говорит
 * xterm не обрабатывать нажатие дальше, то есть не слать его на хост.
 *
 * Ctrl+Shift, а не привычный по редакторам Ctrl: голый Ctrl +/− браузер
 * забирает под масштаб страницы. Сверяется event.code, а не key, — чтобы
 * сочетание работало и в кириллической раскладке.
 */
function handleFontShortcut(event) {
  if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;

  const delta =
    event.code === 'Equal' || event.code === 'NumpadAdd'
      ? 1
      : event.code === 'Minus' || event.code === 'NumpadSubtract'
        ? -1
        : 0;

  if (delta === 0) return true;

  event.preventDefault();
  // Всплытие останавливаем обязательно: возврат false говорит только
  // xterm не обрабатывать нажатие, а событие продолжает подниматься до
  // обработчика на document — и шаг размера выполнялся бы дважды.
  event.stopPropagation();
  changeFontSize(delta);
  return false;
}

term.attachCustomKeyEventHandler(handleFontShortcut);

/* --------------------------------------------------------------- темы */

onThemeChange((flavorId, xtermTheme) => {
  term.options.theme = xtermTheme;
});

function cycleTheme() {
  const index = FLAVOR_IDS.indexOf(getTheme());
  setTheme(FLAVOR_IDS[(index + 1) % FLAVOR_IDS.length]);
  showToast(t('theme.changed', { name: FLAVORS[getTheme()].label }));
}

el('theme-btn').addEventListener('click', cycleTheme);

/* --------------------------------------------------------------- язык */

function cycleLang() {
  const index = LANG_IDS.indexOf(getLang());
  setLang(LANG_IDS[(index + 1) % LANG_IDS.length]);
}

onLangChange(() => {
  applyStatic();
  renderStatus();
  renderOverlay();
  showToast(t('lang.changed', { name: LANGS[getLang()].label }));
});

/* --------------------------------------------------- контекстное меню */

async function copySelection() {
  const selection = term.getSelection();
  if (!selection) {
    showToast(t('toast.nothingSelected'));
    return;
  }
  try {
    await navigator.clipboard.writeText(selection);
    showToast(t('toast.copied'));
  } catch {
    // Clipboard API работает только в защищённом контексте (https или
    // localhost). По http остаётся системное копирование выделения.
    showToast(t('toast.copyNeedsHttps'));
  }
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) socket.write(text);
  } catch {
    // readText не поддерживается частью браузеров и требует разрешения в
    // Safari. Подсказываем системный путь вместо молчаливого отказа.
    showToast(t('toast.pasteUnavailable'));
  }
  term.focus();
}

const menu = new ContextMenu(el('context-menu'), () => [
  {
    text: t('menu.copy'),
    hint: term.hasSelection() ? '' : t('menu.noSelection'),
    disabled: !term.hasSelection(),
    action: copySelection,
  },
  { text: t('menu.paste'), action: pasteFromClipboard },
  { type: 'separator' },
  {
    text: t('menu.clear'),
    action: () => {
      term.clear();
      term.focus();
    },
  },
  {
    text: t('menu.reset'),
    action: () => {
      term.reset();
      socket.resize(term.cols, term.rows);
      term.focus();
    },
  },
  { text: t('menu.find'), action: () => toggleSearch(true) },
  { type: 'separator' },
  // Шаг размера и переключение языка не закрывают меню: и то и другое
  // нажимают подряд, сверяясь с результатом на экране.
  {
    text: t('menu.smaller'),
    hint: String(getFontSize()),
    disabled: !canShrink(),
    keepOpen: true,
    action: () => changeFontSize(-1),
  },
  {
    text: t('menu.larger'),
    hint: String(getFontSize()),
    disabled: !canGrow(),
    keepOpen: true,
    action: () => changeFontSize(1),
  },
  {
    text: t('lang.group'),
    hint: LANGS[getLang()].label,
    keepOpen: true,
    action: cycleLang,
  },
  { type: 'separator' },
  // Единственный путь к настройке второго фактора для обычного
  // пользователя: терминал — единственная страница, которую он видит.
  { text: t('account.title'), action: () => window.location.assign('/account') },
  {
    text: t('menu.downloadLog'),
    disabled: sessionLog.isEmpty,
    action: () => sessionLog.download(),
  },
]);

menu.attachTo(el('terminal-wrap'));
el('menu-btn').addEventListener('click', (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  menu.show(rect.left, rect.bottom + 4);
});

/* -------------------------------------------------------------- поиск */

const searchbar = el('searchbar');
const searchInput = el('search-input');

function toggleSearch(show) {
  searchbar.classList.toggle('hidden', !show);
  if (show) {
    searchInput.focus();
    searchInput.select();
  } else {
    searchAddon.clearDecorations();
    term.focus();
  }
  fitTerminal();
}

el('search-btn').addEventListener('click', () => toggleSearch(searchbar.classList.contains('hidden')));
el('search-close').addEventListener('click', () => toggleSearch(false));
el('search-next').addEventListener('click', () => searchAddon.findNext(searchInput.value));
el('search-prev').addEventListener('click', () => searchAddon.findPrevious(searchInput.value));

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.shiftKey) searchAddon.findPrevious(searchInput.value);
    else searchAddon.findNext(searchInput.value);
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    toggleSearch(false);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    toggleSearch(true);
  }

  // То же сочетание, когда фокус вне терминала — например, в поле поиска.
  // Пока фокус в терминале, событие сюда не доходит: его перехватывает
  // handleFontShortcut выше.
  handleFontShortcut(event);
});

/* -------------------------------------------------------------- выход */

el('logout-btn').addEventListener('click', async () => {
  socket.close();
  try {
    await api.post('/api/logout');
  } catch {
    // Даже если запрос не прошёл, увести человека на форму входа честнее,
    // чем оставить его в терминале без сессии.
  }
  window.location.assign('/login');
});

/* --------------------------------------------------------------- старт */

api
  .get('/api/me')
  .then((result) => {
    if (result.user.role === 'admin') el('admin-link').classList.remove('hidden');
    fitTerminal();
    socket.resize(term.cols, term.rows);
    socket.connect();
  })
  .catch(() => {
    window.location.assign('/login');
  });
