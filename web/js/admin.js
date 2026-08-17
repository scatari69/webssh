import { api } from './common/api.js';
import { initTheme } from './common/theme.js';

initTheme();

const el = (id) => document.getElementById(id);

function fail(message) {
  const box = el('error');
  box.textContent = message;
  box.classList.remove('hidden');
}

el('logout').addEventListener('click', async () => {
  try {
    await api.post('/api/logout');
  } catch {
    // Уводим на форму входа в любом случае.
  }
  window.location.assign('/login');
});

(async () => {
  let me;
  try {
    me = await api.get('/api/me');
  } catch {
    window.location.assign('/login');
    return;
  }

  if (me.user.role !== 'admin') {
    // Маршрут закрыт и на сервере; здесь — чтобы человек увидел причину,
    // а не пустую страницу.
    el('who').textContent = '';
    fail('Раздел доступен только администраторам.');
    return;
  }

  el('who').textContent = `Вы вошли как ${me.user.username}`;
  el('summary').hidden = false;

  try {
    const { ssh_config: cfg } = await api.get('/api/admin/ssh-config');
    el('ssh-status').textContent = cfg.is_configured
      ? `SSH-хост: ${cfg.ssh_username}@${cfg.host}:${cfg.port}, ключ ${cfg.private_key_type} ${cfg.private_key_fingerprint}`
      : 'SSH-хост ещё не настроен — пользователи не смогут открыть терминал.';
    el('ssh-status').className = cfg.is_configured ? 'notice notice-ok' : 'notice notice-warn';
  } catch (err) {
    el('ssh-status').textContent = `Не удалось получить конфигурацию: ${err.message}`;
    el('ssh-status').className = 'notice notice-error';
  }

  try {
    const { users } = await api.get('/api/admin/users');
    const active = users.filter((u) => u.is_active).length;
    el('users-status').textContent = `Пользователей: ${users.length}, из них активных ${active}.`;
  } catch (err) {
    el('users-status').textContent = `Не удалось получить список пользователей: ${err.message}`;
    el('users-status').className = 'notice notice-error';
  }
})();
