/**
 * Мелкие строительные блоки админки: таблицы, диалоги, уведомления,
 * форматирование дат. Всё оформление задаётся классами, разметка собирается
 * узлами DOM, а не строками — тексты сюда приходят из журнала и из полей,
 * которые заполняет человек, и склейка HTML из них была бы точкой инъекции.
 */

import { ApiError } from '../common/api.js';

export const el = (id) => document.getElementById(id);

export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

/* ------------------------------------------------------ уведомления */

let toastTimer = null;

export function toast(message) {
  const box = el('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 3200);
}

export function pageError(message) {
  const box = el('page-error');
  box.textContent = message || '';
  box.classList.toggle('hidden', !message);
}

/**
 * Единый разбор ошибки запроса. Протухшая сессия — не повод показывать
 * сообщение: работать всё равно нечем, и человека нужно отправить на форму
 * входа, а не оставлять перед мёртвой страницей.
 */
export function reportError(err) {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.code === 'account_disabled') {
      window.location.assign('/login');
      return;
    }
    toast(err.message);
    return;
  }
  toast('Сервер недоступен.');
}

export async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/* ------------------------------------------------------------ даты */

/*
 * В базе времена лежат в UTC с суффиксом Z, поэтому Date разбирает их
 * однозначно, а Intl показывает в часовом поясе того, кто смотрит.
 */
const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });
const DATE_ONLY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function format(formatter, iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : formatter.format(date);
}

export const formatDateTime = (iso) => format(DATE_TIME, iso);
export const formatDate = (iso) => format(DATE_ONLY, iso);

/* --------------------------------------------------------- таблицы */

/**
 * Таблица, которая на узком экране разбирается в карточки (см. admin.css).
 *
 * Роли проставлены явно: при смене display на block браузер перестаёт
 * считать элементы таблицей, и без ролей строки исчезают из дерева
 * доступности — экранный диктор увидел бы набор безымянных блоков.
 *
 * @param {HTMLElement} container
 * @param {{columns: Array, rows: Array, empty?: string, rowAttrs?: Function}} spec
 */
export function renderTable(container, { columns, rows, empty = 'Пока пусто', rowAttrs }) {
  container.replaceChildren();

  if (!rows.length) {
    container.append(node('p', 'empty', empty));
    return;
  }

  const table = node('table', 'data-table');
  table.setAttribute('role', 'table');

  const thead = document.createElement('thead');
  thead.setAttribute('role', 'rowgroup');
  const headRow = document.createElement('tr');
  headRow.setAttribute('role', 'row');
  for (const column of columns) {
    const th = node('th', null, column.label);
    th.setAttribute('role', 'columnheader');
    th.setAttribute('scope', 'col');
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  tbody.setAttribute('role', 'rowgroup');

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.setAttribute('role', 'row');
    if (rowAttrs) {
      for (const [name, value] of Object.entries(rowAttrs(row))) tr.setAttribute(name, value);
    }

    for (const column of columns) {
      const td = document.createElement('td');
      td.setAttribute('role', 'cell');
      // Подпись, которая на узком экране заменяет заголовок колонки.
      td.dataset.label = column.mobileLabel === undefined ? column.label : column.mobileLabel;

      const content = column.cell(row);
      if (content instanceof Node) td.append(content);
      else td.append(node('span', 'cell-value', content));

      tr.append(td);
    }

    tbody.append(tr);
  }

  table.append(thead, tbody);
  container.append(table);
}

/* --------------------------------------------------------- диалоги */

let closeDialog = null;

function setupDialog() {
  const dialog = el('app-dialog');
  const confirmBtn = el('dialog-confirm');
  const cancelBtn = el('dialog-cancel');

  cancelBtn.addEventListener('click', () => dialog.close('cancel'));

  // Щелчок мимо содержимого закрывает диалог. Событие приходит от самого
  // <dialog>, только когда попало в подложку: содержимое перехватывает его
  // раньше.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close('cancel');
  });

  dialog.addEventListener('close', () => {
    if (closeDialog) {
      const done = closeDialog;
      closeDialog = null;
      done(null);
    }
  });

  dialog.addEventListener('keydown', (event) => {
    // Enter подтверждает — но не в многострочном поле, где он значит перевод
    // строки. Escape закрывает сам <dialog>.
    if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
      event.preventDefault();
      confirmBtn.click();
    }
  });

  return { dialog, confirmBtn };
}

let dialogParts = null;

/**
 * Открывает модальный диалог и разрешается значением из `collect` либо
 * null, если человек отказался (кнопка, Escape, щелчок мимо).
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} [spec.message]
 * @param {Node} [spec.slot] произвольное содержимое — поля ввода, секрет
 * @param {string} [spec.confirmLabel]
 * @param {string|null} [spec.cancelLabel] null убирает кнопку отказа
 * @param {boolean} [spec.danger] красная кнопка подтверждения
 * @param {() => any} [spec.collect] значение результата; строка-исключение
 *   показывается в диалоге, не закрывая его
 * @returns {Promise<any|null>}
 */
export function openDialog({
  title,
  message = '',
  slot = null,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  danger = false,
  collect = null,
}) {
  if (!dialogParts) dialogParts = setupDialog();
  const { dialog, confirmBtn } = dialogParts;

  el('dialog-title').textContent = title;
  const messageBox = el('dialog-message');
  messageBox.textContent = message;
  messageBox.classList.toggle('hidden', !message);

  const slotBox = el('dialog-slot');
  slotBox.replaceChildren();
  if (slot) slotBox.append(slot);

  const errorBox = el('dialog-error');
  errorBox.textContent = '';
  errorBox.classList.add('hidden');

  confirmBtn.textContent = confirmLabel;
  confirmBtn.classList.toggle('btn-danger', danger);
  confirmBtn.classList.toggle('btn-primary', !danger);

  const cancelBtn = el('dialog-cancel');
  cancelBtn.classList.toggle('hidden', cancelLabel === null);
  if (cancelLabel !== null) cancelBtn.textContent = cancelLabel;

  return new Promise((resolve) => {
    closeDialog = resolve;

    const onConfirm = () => {
      let value = true;
      if (collect) {
        try {
          value = collect();
        } catch (err) {
          errorBox.textContent = err.message;
          errorBox.classList.remove('hidden');
          return;
        }
      }
      confirmBtn.removeEventListener('click', onConfirm);
      closeDialog = null;
      dialog.close('confirm');
      resolve(value);
    };

    confirmBtn.addEventListener('click', onConfirm);
    dialog.addEventListener('close', () => confirmBtn.removeEventListener('click', onConfirm), {
      once: true,
    });

    dialog.showModal();

    // Фокус по умолчанию уходит на первый элемент, способный его принять,
    // — то есть на кнопку отказа. Для разрушительных действий это и нужно:
    // случайный Enter не должен что-либо удалять.
    if (slot) {
      const field = slot.querySelector('input, select, textarea');
      if (field) field.focus();
    }
  });
}

export function confirmAction({ title, message, confirmLabel = 'Подтвердить', danger = true }) {
  return openDialog({ title, message, confirmLabel, danger });
}

/**
 * Одноразовый показ секрета: сгенерированного пароля. Кнопка копирования
 * работает не всегда — Clipboard API требует защищённого контекста, — и
 * поэтому сам текст всегда виден и выделяется одним щелчком.
 */
export function showSecret({ title, message, secret }) {
  const slot = node('div');
  const value = node('div', 'secret-value mono', secret);
  const copy = node('button', 'btn btn-small', 'Скопировать');
  copy.type = 'button';
  copy.style.marginTop = '12px';

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(secret);
      copy.textContent = 'Скопировано';
    } catch {
      copy.textContent = 'Скопируйте вручную';
    }
  });

  slot.append(value, copy);

  return openDialog({
    title,
    message,
    slot,
    confirmLabel: 'Готово',
    cancelLabel: null,
    collect: () => true,
  });
}
