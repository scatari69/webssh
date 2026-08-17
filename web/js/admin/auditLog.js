/**
 * Журнал действий. Поскольку на целевом хосте у всех одна и та же
 * системная учётная запись, это единственное место, где видно, кто именно
 * что сделал, — поэтому показываем сырой код действия рядом с пояснением,
 * а не вместо него: по коду можно искать, пояснение нужно читать.
 */

import { api } from '../common/api.js';
import { t } from '../common/i18n.js';
import { el, formatDateTime, node, renderTable, reportError, withBusy } from './ui.js';

const LIMIT = 100;


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
  // Незнакомый код показываем как есть: перевод может отстать от сервера,
  // и пустая строка вместо действия была бы хуже сырого кода.
  const label = t(`action.${entry.action}`);
  box.append(node('div', null, label === `action.${entry.action}` ? entry.action : label));
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
        ? t('audit.shownOf', { shown: data.entries.length, total: data.total })
        : t('audit.total', { total: data.total });

    renderTable(container, {
      rows: data.entries,
      empty: t('audit.empty'),
      columns: [
        { label: t('audit.colTime'), cell: (entry) => formatDateTime(entry.created_at) },
        { label: t('audit.colAction'), cell: actionCell },
        { label: t('audit.colActor'), cell: (entry) => entry.actor_username || '—' },
        {
          label: t('audit.colOutcome'),
          cell: (entry) =>
            node(
              'span',
              entry.outcome === 'success' ? 'chip chip-ok' : 'chip chip-off',
              entry.outcome === 'success' ? t('audit.success') : t('audit.failure')
            ),
        },
        { label: t('audit.colTarget'), cell: targetCell },
        { label: t('audit.colIp'), cell: (entry) => entry.ip || '—' },
        { label: t('audit.colDetail'), cell: detailCell },
      ],
    });
  } catch (err) {
    reportError(err);
    container.replaceChildren(node('p', 'empty', t('audit.loadFailed')));
  }
}

export function initAuditLog() {
  el('audit-refresh').addEventListener('click', (event) => withBusy(event.currentTarget, load));
  return load();
}

export { load as reloadAuditLog };
