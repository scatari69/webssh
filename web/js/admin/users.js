/** Список пользователей приложения: создание, сброс пароля, отключение. */

import { api } from '../common/api.js';
import {
  confirmAction,
  el,
  formatDate,
  node,
  openDialog,
  renderTable,
  reportError,
  showSecret,
  toast,
  withBusy,
} from './ui.js';

const MIN_PASSWORD_LENGTH = 12;

let me = null;
let onChanged = () => {};

function chip(text, extraClass) {
  return node('span', extraClass ? `chip ${extraClass}` : 'chip', text);
}

function stateCell(user) {
  const box = node('span', 'cell-value');
  box.append(
    user.is_active ? chip('активен', 'chip-ok') : chip('отключён', 'chip-off'),
    user.totp_enabled ? chip('2FA') : chip('без 2FA', 'chip-warn')
  );
  return box;
}

function actionsCell(user, reload) {
  const box = node('div', 'cell-actions');

  const reset = node('button', 'btn btn-small', 'Сбросить пароль');
  reset.type = 'button';
  reset.addEventListener('click', () => resetPassword(user, reload, reset));
  box.append(reset);

  if (user.totp_enabled) {
    const totp = node('button', 'btn btn-small', 'Сбросить 2FA');
    totp.type = 'button';
    totp.addEventListener('click', () => resetTotp(user, reload, totp));
    box.append(totp);
  }

  // Учётные записи не удаляются, а отключаются: на них ссылается журнал, и
  // разрыв этой связи стёр бы ответ на вопрос «кто это сделал». Поэтому
  // кнопка парная — обратный путь должен быть виден рядом.
  if (user.is_active) {
    const off = node('button', 'btn btn-small btn-danger', 'Отключить');
    off.type = 'button';
    off.addEventListener('click', () => deactivate(user, reload, off));
    box.append(off);
  } else {
    const on = node('button', 'btn btn-small', 'Включить');
    on.type = 'button';
    on.addEventListener('click', () => activate(user, reload, on));
    box.append(on);
  }

  return box;
}

/* ------------------------------------------------------- действия */

async function deactivate(user, reload, button) {
  const self = me && me.id === user.id;
  const confirmed = await confirmAction({
    title: `Отключить «${user.username}»?`,
    message:
      (self ? 'Это ваша собственная учётная запись: после отключения вы потеряете доступ к админке. ' : '') +
      'Учётная запись останется в базе, но войти по ней будет нельзя, а открытые терминалы закроются сразу. ' +
      'Включить обратно можно кнопкой рядом.',
    confirmLabel: 'Отключить',
  });
  if (!confirmed) return;

  await withBusy(button, async () => {
    try {
      const res = await api.del(`/api/admin/users/${user.id}`);
      const closed = res.terminals_closed || 0;
      toast(closed ? `«${user.username}» отключён, терминалов закрыто: ${closed}` : `«${user.username}» отключён`);
      await reload();
      onChanged();
    } catch (err) {
      reportError(err);
    }
  });
}

async function activate(user, reload, button) {
  await withBusy(button, async () => {
    try {
      await api.patch(`/api/admin/users/${user.id}`, { is_active: true });
      toast(`«${user.username}» включён`);
      await reload();
      onChanged();
    } catch (err) {
      reportError(err);
    }
  });
}

async function resetPassword(user, reload, button) {
  const slot = node('div', 'field');
  const input = node('input', 'input');
  input.type = 'text';
  input.placeholder = 'будет сгенерирован';
  input.autocapitalize = 'none';
  input.spellcheck = false;
  input.disabled = true;

  const label = node('label', 'checkbox');
  const generate = node('input');
  generate.type = 'checkbox';
  generate.checked = true;
  label.append(generate, document.createTextNode(' Сгенерировать'));

  generate.addEventListener('change', () => {
    input.disabled = generate.checked;
    if (!generate.checked) input.focus();
    else input.value = '';
  });

  slot.append(input, label);

  const result = await openDialog({
    title: `Сбросить пароль «${user.username}»?`,
    message:
      'Открытые веб-сессии и терминалы этого пользователя закроются немедленно. ' +
      'Новый пароль показывается один раз — восстановить его потом неоткуда.',
    slot,
    confirmLabel: 'Сбросить',
    danger: true,
    collect: () => {
      if (generate.checked) return { password: undefined };
      const value = input.value;
      if (value.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`Пароль короче ${MIN_PASSWORD_LENGTH} символов.`);
      }
      return { password: value };
    },
  });

  if (!result) return;

  await withBusy(button, async () => {
    try {
      const res = await api.patch(`/api/admin/users/${user.id}/password`, result);
      await reload();
      onChanged();

      if (res.temporary_password) {
        await showSecret({
          title: 'Новый пароль',
          message: `Передайте его пользователю «${user.username}». Больше он нигде не появится.`,
          secret: res.temporary_password,
        });
      } else {
        toast(`Пароль «${user.username}» изменён`);
      }
    } catch (err) {
      reportError(err);
    }
  });
}

async function resetTotp(user, reload, button) {
  const confirmed = await confirmAction({
    title: `Сбросить двухфакторку «${user.username}»?`,
    message:
      'Привязка и коды восстановления удалятся. Если для этой роли второй фактор обязателен, ' +
      'следующий вход начнётся с новой привязки.',
    confirmLabel: 'Сбросить',
  });
  if (!confirmed) return;

  await withBusy(button, async () => {
    try {
      await api.del(`/api/admin/users/${user.id}/totp`);
      toast(`Двухфакторка «${user.username}» сброшена`);
      await reload();
      onChanged();
    } catch (err) {
      reportError(err);
    }
  });
}

/* -------------------------------------------------------- создание */

function bindCreateForm(reload) {
  const form = el('create-user-form');
  const generate = el('new-password-generate');
  const passwordInput = el('new-password');

  generate.addEventListener('change', () => {
    passwordInput.disabled = generate.checked;
    if (generate.checked) passwordInput.value = '';
    else passwordInput.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = {
      username: el('new-username').value.trim(),
      role: el('new-role').value,
    };
    // Пароль не передаём вовсе, когда его должен сгенерировать сервер:
    // пустая строка на той стороне означает то же самое, но явное
    // отсутствие поля читается однозначнее.
    if (!generate.checked) payload.password = passwordInput.value;

    await withBusy(el('create-user-submit'), async () => {
      try {
        const res = await api.post('/api/admin/users', payload);
        form.reset();
        passwordInput.disabled = true;
        await reload();
        onChanged();

        if (res.temporary_password) {
          await showSecret({
            title: `Пользователь «${res.user.username}» создан`,
            message: 'Пароль показывается один раз — передайте его и закройте окно.',
            secret: res.temporary_password,
          });
        } else {
          toast(`Пользователь «${res.user.username}» создан`);
        }
      } catch (err) {
        reportError(err);
      }
    });
  });
}

/* ---------------------------------------------------------- список */

async function load() {
  const container = el('users-table');
  try {
    const { users } = await api.get('/api/admin/users');

    renderTable(container, {
      rows: users,
      rowAttrs: (user) => ({
        'data-username': user.username,
        'data-self': String(Boolean(me && me.id === user.id)),
      }),
      empty: 'Пользователей нет.',
      columns: [
        {
          label: 'Логин',
          cell: (user) => {
            const box = node('span', 'cell-value');
            box.append(node('span', 'mono', user.username));
            if (me && me.id === user.id) box.append(node('span', 'chip', 'это вы'));
            return box;
          },
        },
        {
          label: 'Роль',
          cell: (user) =>
            user.role === 'admin'
              ? chip('администратор', 'chip-admin')
              : node('span', 'cell-value', 'пользователь'),
        },
        { label: 'Создан', cell: (user) => formatDate(user.created_at) },
        { label: 'Состояние', cell: stateCell },
        { label: 'Действия', mobileLabel: '', cell: (user) => actionsCell(user, load) },
      ],
    });
  } catch (err) {
    reportError(err);
    container.replaceChildren(node('p', 'empty', 'Список не загрузился.'));
  }
}

export function initUsers({ currentUser, onChange }) {
  me = currentUser;
  if (onChange) onChanged = onChange;

  bindCreateForm(load);
  el('users-refresh').addEventListener('click', (event) => withBusy(event.currentTarget, load));

  return load();
}
