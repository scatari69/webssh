/**
 * Точка входа админки.
 *
 * Доступ закрыт на сервере: /admin отдаётся только роли admin, остальных
 * уводит редиректом, и каждый вызов /api/admin/* проверяется отдельно.
 * Здесь проверка повторяется лишь затем, чтобы человек увидел причину, а не
 * пустую страницу, если попал сюда с чужой сессией.
 */

import { api } from '../common/api.js';
import { FLAVOR_IDS } from '../common/catppuccin.js';
import { FLAVORS, getTheme, initTheme, setTheme } from '../common/theme.js';
import { initAuditLog, reloadAuditLog } from './auditLog.js';
import { initSshHost } from './sshHost.js';
import { el, node, pageError, reportError } from './ui.js';
import { initUsers } from './users.js';

initTheme();

function renderThemeChips() {
  const row = el('theme-row');
  row.replaceChildren(
    ...FLAVOR_IDS.map((id) => {
      const chip = node('button', 'theme-chip', FLAVORS[id].label);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(id === getTheme()));
      chip.addEventListener('click', () => {
        setTheme(id);
        renderThemeChips();
      });
      return chip;
    })
  );
}

el('logout').addEventListener('click', async () => {
  try {
    await api.post('/api/logout');
  } catch {
    // Уводим на форму входа в любом случае: сессии здесь уже нет либо она
    // всё равно бесполезна.
  }
  window.location.assign('/login');
});

renderThemeChips();

(async () => {
  let me;
  try {
    ({ user: me } = await api.get('/api/me'));
  } catch {
    window.location.assign('/login');
    return;
  }

  el('whoami').textContent = `Вы вошли как ${me.username}`;

  if (me.role !== 'admin') {
    el('admin-main').hidden = false;
    pageError('Раздел доступен только администраторам.');
    return;
  }

  el('admin-main').hidden = false;

  // Действия в одном разделе оставляют след в другом: создание пользователя
  // и правка хоста попадают в журнал, поэтому он перечитывается следом.
  const refreshAudit = () => {
    reloadAuditLog().catch(reportError);
  };

  await Promise.all([
    initUsers({ currentUser: me, onChange: refreshAudit }),
    initSshHost({ onChange: refreshAudit }),
    initAuditLog(),
  ]);
})();
