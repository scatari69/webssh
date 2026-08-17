import { FitAddon } from '/vendor/addon-fit.mjs';
import { SearchAddon } from '/vendor/addon-search.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { Terminal } from '/vendor/xterm.mjs';

import { api } from '../common/api.js';
import { FLAVOR_IDS, FLAVORS } from '../common/catppuccin.js';
import { getTheme, initTheme, onThemeChange, setTheme, toXtermTheme } from '../common/theme.js';
import { ContextMenu } from './contextMenu.js';
import { MobileKeys } from './mobileKeys.js';
import { SessionLog } from './sessionLog.js';
import { TerminalSocket } from './socket.js';
import { initViewport } from './viewport.js';

initTheme();

const el = (id) => document.getElementById(id);

const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
document.body.dataset.touch = String(isTouch);

/* ------------------------------------------------------------ терминал */

const term = new Terminal({
  theme: toXtermTheme(getTheme()),
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSize: isTouch ? 13 : 14,
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

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusTextEl.textContent = text;
}

function showOverlay({ kind = 'info', title, message = '', action = null }) {
  overlayEl.dataset.kind = kind;
  overlayTitleEl.textContent = title;
  overlayMessageEl.textContent = message;

  if (action) {
    overlayActionEl.textContent = action.label;
    overlayActionEl.onclick = action.onClick;
    overlayActionEl.classList.remove('hidden');
  } else {
    overlayActionEl.classList.add('hidden');
    overlayActionEl.onclick = null;
  }

  overlayEl.classList.remove('hidden');
}

function hideOverlay() {
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
        setStatus('connected', 'Подключено');
        term.focus();
        break;

      case 'error':
        lastError = message;
        break;

      case 'exit':
        setStatus('closed', 'Сессия завершена');
        break;

      default:
        break;
    }
  },

  onState(state) {
    switch (state.state) {
      case 'connecting':
        setStatus('connecting', 'Подключение…');
        showOverlay({ title: 'Подключение…', message: 'Устанавливаем SSH-соединение с хостом.' });
        break;

      case 'reconnecting': {
        if (state.retryInSeconds === undefined) {
          setStatus('reconnecting', 'Соединение разорвано');
          break;
        }
        const text = `Соединение разорвано, переподключение через ${state.retryInSeconds} с`;
        setStatus('reconnecting', text);
        showOverlay({
          kind: 'info',
          title: 'Соединение разорвано',
          message: `${
            lastError ? `${lastError.message} ` : ''
          }Повторная попытка через ${state.retryInSeconds} с.`,
          action: { label: 'Переподключиться сейчас', onClick: () => socket.retryNow() },
        });
        break;
      }

      case 'closed':
        setStatus('closed', 'Сессия завершена');
        showOverlay({
          title: 'Сессия завершена',
          message: 'Шелл на хосте закрыт.',
          action: { label: 'Открыть заново', onClick: () => socket.retryNow() },
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

  setStatus('error', error ? error.message : 'Ошибка соединения');

  // Сессия недействительна — дальше только через форму входа.
  if (state.code === 4401 || state.code === 4403) {
    showOverlay({
      kind: 'error',
      title: 'Требуется вход',
      message: (error && error.message) || 'Сессия истекла или учётная запись отключена.',
      action: { label: 'На страницу входа', onClick: () => window.location.assign('/login') },
    });
    setTimeout(() => window.location.assign('/login'), 2500);
    return;
  }

  const titles = {
    ssh_not_configured: 'SSH-хост не настроен',
    ssh_key_unreadable: 'Проблема с ключом',
    ssh_auth_failed: 'Хост отверг ключ',
    ssh_host_key_mismatch: 'Ключ хоста не совпал',
    session_limit_user: 'Слишком много сессий',
    session_limit_total: 'Сервер занят',
    idle_timeout: 'Сессия закрыта из-за простоя',
  };

  showOverlay({
    kind: 'error',
    title: titles[code] || 'Не удалось подключиться',
    message:
      (error && error.message) ||
      'Соединение закрыто сервером. Подробности могут быть в журнале администратора.',
    action: { label: 'Попробовать снова', onClick: () => socket.retryNow() },
  });
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

/* --------------------------------------------------------------- темы */

onThemeChange((flavorId, xtermTheme) => {
  term.options.theme = xtermTheme;
});

function cycleTheme() {
  const index = FLAVOR_IDS.indexOf(getTheme());
  setTheme(FLAVOR_IDS[(index + 1) % FLAVOR_IDS.length]);
  showToast(`Тема: ${FLAVORS[getTheme()].label}`);
}

el('theme-btn').addEventListener('click', cycleTheme);

/* --------------------------------------------------- контекстное меню */

async function copySelection() {
  const selection = term.getSelection();
  if (!selection) {
    showToast('Ничего не выделено');
    return;
  }
  try {
    await navigator.clipboard.writeText(selection);
    showToast('Скопировано');
  } catch {
    // Clipboard API работает только в защищённом контексте (https или
    // localhost). По http остаётся системное копирование выделения.
    showToast('Копирование недоступно без HTTPS');
  }
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) socket.write(text);
  } catch {
    // readText не поддерживается частью браузеров и требует разрешения в
    // Safari. Подсказываем системный путь вместо молчаливого отказа.
    showToast('Вставка недоступна: используйте Cmd/Ctrl+V или жест системы');
  }
  term.focus();
}

const menu = new ContextMenu(el('context-menu'), () => {
  const items = [
    { text: 'Копировать', hint: term.hasSelection() ? '' : 'нет выделения', disabled: !term.hasSelection(), action: copySelection },
    { text: 'Вставить', action: pasteFromClipboard },
    { type: 'separator' },
    { text: 'Очистить экран', action: () => { term.clear(); term.focus(); } },
    { text: 'Сбросить терминал', action: () => { term.reset(); socket.resize(term.cols, term.rows); term.focus(); } },
    { text: 'Найти…', action: () => toggleSearch(true) },
    { type: 'separator' },
    { type: 'label', text: 'Тема' },
  ];

  for (const id of FLAVOR_IDS) {
    items.push({
      text: FLAVORS[id].label,
      checked: id === getTheme(),
      action: () => setTheme(id),
    });
  }

  items.push({ type: 'separator' });
  items.push({
    text: 'Скачать журнал сессии',
    disabled: sessionLog.isEmpty,
    action: () => sessionLog.download(),
  });

  return items;
});

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
