/** Список пользователей приложения: создание, сброс пароля, отключение. */

import { api } from '../common/api.js';
import { t } from '../common/i18n.js';
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
    user.is_active ? chip(t('users.stateActive'), 'chip-ok') : chip(t('users.stateDisabled'), 'chip-off'),
    user.totp_enabled ? chip(t('users.has2fa')) : chip(t('users.no2fa'), 'chip-warn')
  );
  return box;
}

function actionsCell(user, reload) {
  const box = node('div', 'cell-actions');

  const reset = node('button', 'btn btn-small', t('users.resetPassword'));
  reset.type = 'button';
  reset.addEventListener('click', () => resetPassword(user, reload, reset));
  box.append(reset);

  if (user.totp_enabled) {
    const totp = node('button', 'btn btn-small', t('users.reset2fa'));
    totp.type = 'button';
    totp.addEventListener('click', () => resetTotp(user, reload, totp));
    box.append(totp);
  }

  // Учётные записи не удаляются, а отключаются: на них ссылается журнал, и
  // разрыв этой связи стёр бы ответ на вопрос «кто это сделал». Поэтому
  // кнопка парная — обратный путь должен быть виден рядом.
  if (user.is_active) {
    const off = node('button', 'btn btn-small btn-danger', t('users.disable'));
    off.type = 'button';
    off.addEventListener('click', () => deactivate(user, reload, off));
    box.append(off);
  } else {
    const on = node('button', 'btn btn-small', t('users.enable'));
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
    title: t('users.confirmDisableTitle', { user: user.username }),
    message:
      (self ? t('users.confirmDisableSelf') : '') + t('users.confirmDisableBody'),
    confirmLabel: t('users.disable'),
  });
  if (!confirmed) return;

  await withBusy(button, async () => {
    try {
      const res = await api.del(`/api/admin/users/${user.id}`);
      const closed = res.terminals_closed || 0;
      toast(
        closed
          ? t('users.disabledToastWithTerminals', { user: user.username, count: closed })
          : t('users.disabledToast', { user: user.username })
      );
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
      toast(t('users.enabledToast', { user: user.username }));
      await reload();
      onChanged();
    } catch (err) {
      reportError(err);
    }
  });
}

async function resetPassword(user, reload, button) {
  const self = Boolean(me && me.id === user.id);
  const slot = node('div', 'field');
  const input = node('input', 'input');
  input.type = 'text';
  input.placeholder = t('users.newPasswordPlaceholder');
  input.autocapitalize = 'none';
  input.spellcheck = false;
  input.disabled = true;

  const label = node('label', 'checkbox');
  const generate = node('input');
  generate.type = 'checkbox';
  generate.checked = true;
  label.append(generate, document.createTextNode(` ${t('users.generate')}`));

  generate.addEventListener('change', () => {
    input.disabled = generate.checked;
    if (!generate.checked) input.focus();
    else input.value = '';
  });

  slot.append(input, label);

  const result = await openDialog({
    title: t('users.confirmResetTitle', { user: user.username }),
    message: (self ? t('users.confirmResetSelf') : '') + t('users.confirmResetBody'),
    slot,
    confirmLabel: t('users.resetPassword'),
    danger: true,
    collect: () => {
      if (generate.checked) return { password: undefined };
      const value = input.value;
      if (value.length < MIN_PASSWORD_LENGTH) {
        throw new Error(t('users.passwordTooShort', { min: MIN_PASSWORD_LENGTH }));
      }
      return { password: value };
    },
  });

  if (!result) return;

  await withBusy(button, async () => {
    let res;
    try {
      res = await api.patch(`/api/admin/users/${user.id}/password`, result);
    } catch (err) {
      reportError(err);
      return;
    }

    /*
     * Порядок здесь принципиален. Сгенерированный пароль существует
     * ровно в этом ответе — в базе только bcrypt-хеш, — поэтому он
     * показывается ПЕРВЫМ, до любых обновлений списка.
     *
     * Раньше сначала перечитывался список, и на своей учётной записи это
     * ломалось наглухо: смена пароля обесценивает собственную сессию, и
     * запрос списка отвечал 401, а обработчик ошибки уводил на форму
     * входа — до того, как окно с паролем успевало открыться. Пароль был
     * потерян безвозвратно, а единственный администратор оставался
     * заперт снаружи.
     */
    if (res.temporary_password) {
      await showSecret({
        title: t('users.newPasswordTitle'),
        message: self
          ? t('users.newPasswordSelfMessage')
          : t('users.newPasswordMessage', { user: user.username }),
        secret: res.temporary_password,
      });
    } else if (self) {
      await openDialog({
        title: t('users.passwordChangedSelfTitle'),
        message: t('users.newPasswordSelfMessage'),
        confirmLabel: t('dialog.done'),
        cancelLabel: null,
        collect: () => true,
      });
    } else {
      toast(t('users.passwordChanged', { user: user.username }));
    }

    // Своя сессия смертью пароля уже недействительна: обновлять список
    // нечем и незачем, а уход на форму входа делаем осознанно — так
    // человек понимает, что произошло, а не выпадает туда молча.
    if (self) {
      window.location.assign('/login');
      return;
    }

    await reload();
    onChanged();
  });
}

async function resetTotp(user, reload, button) {
  const confirmed = await confirmAction({
    title: t('users.confirm2faTitle', { user: user.username }),
    message: t('users.confirm2faBody'),
    confirmLabel: t('users.reset2fa'),
  });
  if (!confirmed) return;

  await withBusy(button, async () => {
    try {
      await api.del(`/api/admin/users/${user.id}/totp`);
      toast(t('users.reset2faToast', { user: user.username }));
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

        // Сначала пароль, потом список: он одноразовый, список — нет.
        if (res.temporary_password) {
          await showSecret({
            title: t('users.createdTitle', { user: res.user.username }),
            message: t('users.createdMessage'),
            secret: res.temporary_password,
          });
        } else {
          toast(t('users.createdToast', { user: res.user.username }));
        }

        await reload();
        onChanged();
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
      empty: t('users.empty'),
      columns: [
        {
          label: t('users.colLogin'),
          cell: (user) => {
            const box = node('span', 'cell-value');
            box.append(node('span', 'mono', user.username));
            if (me && me.id === user.id) box.append(node('span', 'chip', t('users.you')));
            return box;
          },
        },
        {
          label: t('users.colRole'),
          cell: (user) =>
            user.role === 'admin'
              ? chip(t('users.roleAdmin'), 'chip-admin')
              : node('span', 'cell-value', t('users.roleUser')),
        },
        { label: t('users.colCreated'), cell: (user) => formatDate(user.created_at) },
        { label: t('users.colState'), cell: stateCell },
        { label: t('users.colActions'), mobileLabel: '', cell: (user) => actionsCell(user, load) },
      ],
    });
  } catch (err) {
    reportError(err);
    container.replaceChildren(node('p', 'empty', t('users.loadFailed')));
  }
}

export { load as reloadUsers };

export function initUsers({ currentUser, onChange }) {
  me = currentUser;
  if (onChange) onChanged = onChange;

  bindCreateForm(load);
  el('users-refresh').addEventListener('click', (event) => withBusy(event.currentTarget, load));

  return load();
}
