/**
 * Журнал действий. Поскольку на целевом хосте у всех одна и та же
 * системная учётная запись, это единственное место, где видно, кто именно
 * что сделал, — поэтому показываем сырой код действия рядом с пояснением,
 * а не вместо него: по коду можно искать, пояснение нужно читать.
 */

import { api } from '../common/api.js';
import { el, formatDateTime, node, renderTable, reportError, withBusy } from './ui.js';

const LIMIT = 100;

const ACTIONS = {
  'auth.login': 'Вход',
  'auth.logout': 'Выход',
  'auth.mfa_challenge': 'Запрошен второй фактор',
  'totp.enrollment_started': 'Начата привязка 2FA',
  'totp.enrollment_confirmed': 'Двухфакторка привязана',
  'totp.disabled': 'Двухфакторка отключена',
  'totp.recovery_codes_regenerated': 'Перевыпущены коды восстановления',
  'totp.reset_by_admin': 'Двухфакторка сброшена администратором',
  'user.created': 'Создан пользователь',
  'user.activated': 'Пользователь включён',
  'user.deactivated': 'Пользователь отключён',
  'user.password_reset': 'Сброшен пароль',
  'ssh_config.updated': 'Изменены настройки хоста',
  'ssh_config.key_replaced': 'Заменён приватный ключ',
  'ssh_config.host_key_learned': 'Запомнен ключ хоста',
  'ssh_config.host_key_mismatch': 'Ключ хоста не совпал',
  'terminal.open': 'Открыт терминал',
  'terminal.close': 'Закрыт терминал',
  'terminal.rejected': 'Терминал не открылся',
};

/** `{a: 1, b: {c: 2}}` → `a=1  b={"c":2}` — компактнее JSON и читается. */
function describeDetail(detail) {
  if (!detail || typeof detail !== 'object') return '';
  return Object.entries(detail)
    .map(([key, value]) => {
      const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}=${text}`;
    })
    .join('  ');
}

function actionCell(entry) {
  const box = node('span', 'cell-value');
  box.append(node('div', null, ACTIONS[entry.action] || entry.action));
  box.append(node('div', 'field-hint mono', entry.action));
  return box;
}

function targetCell(entry) {
  const box = node('span', 'cell-value');
  if (entry.target_type) {
    box.append(node('div', null, entry.target_id ? `${entry.target_type} #${entry.target_id}` : entry.target_type));
  }
  if (entry.terminal_session_id) {
    box.append(node('div', 'field-hint mono', entry.terminal_session_id));
  }
  if (!box.childNodes.length) box.append(document.createTextNode('—'));
  return box;
}

function detailCell(entry) {
  const text = describeDetail(entry.detail);
  const box = node('span', 'detail-cell', text || '—');
  // На десктопе строка обрезается многоточием, поэтому полный текст
  // остаётся доступным в подсказке.
  if (text) box.title = text;
  return box;
}

async function load() {
  const container = el('audit-table');

  try {
    const data = await api.get(`/api/admin/audit?limit=${LIMIT}`);

    el('audit-count').textContent =
      data.total > data.entries.length
        ? `показаны последние ${data.entries.length} из ${data.total}`
        : `записей: ${data.total}`;

    renderTable(container, {
      rows: data.entries,
      empty: 'Журнал пуст.',
      columns: [
        { label: 'Время', cell: (entry) => formatDateTime(entry.created_at) },
        { label: 'Действие', cell: actionCell },
        { label: 'Кто', cell: (entry) => entry.actor_username || '—' },
        {
          label: 'Итог',
          cell: (entry) =>
            node(
              'span',
              entry.outcome === 'success' ? 'chip chip-ok' : 'chip chip-off',
              entry.outcome === 'success' ? 'успех' : 'отказ'
            ),
        },
        { label: 'Объект', cell: targetCell },
        { label: 'Адрес', cell: (entry) => entry.ip || '—' },
        { label: 'Подробности', cell: detailCell },
      ],
    });
  } catch (err) {
    reportError(err);
    container.replaceChildren(node('p', 'empty', 'Журнал не загрузился.'));
  }
}

export function initAuditLog() {
  el('audit-refresh').addEventListener('click', (event) => withBusy(event.currentTarget, load));
  return load();
}

export { load as reloadAuditLog };
