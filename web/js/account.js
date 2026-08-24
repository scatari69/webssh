/**
 * Личные настройки: второй фактор.
 *
 * До этой страницы привязать TOTP можно было только внутри формы входа, и
 * только если сервер сам её потребовал — то есть администратору. Обычный
 * пользователь, которому второй фактор доброволен, включить его не мог
 * нигде: эндпоинты были, входа в них не было.
 */

import { ApiError, api } from './common/api.js';
import { LANGS, LANG_IDS, applyStatic, getLang, initI18n, setLang, t } from './common/i18n.js';
import { initTheme } from './common/theme.js';

initTheme();
initI18n();
applyStatic();

const el = (id) => document.getElementById(id);

const steps = {
  state: el('state-step'),
  enroll: el('enroll-step'),
  recovery: el('recovery-step'),
};

let me = null;
let totp = { required: false, recovery_codes_remaining: 0 };

function showStep(name) {
  for (const [key, node] of Object.entries(steps)) {
    node.classList.toggle('hidden', key !== name);
  }
}

function showError(message) {
  const box = el('error');
  box.textContent = message || '';
  box.classList.toggle('hidden', !message);
}

function toast(text) {
  const box = el('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    box.hidden = true;
  }, 2600);
}

function describe(err) {
  return err instanceof ApiError ? err.message : t('login.serverUnavailable');
}

async function busy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/* ------------------------------------------------------- состояние */

function renderState() {
  const enabled = Boolean(me.totp_enabled);
  const notice = el('state-notice');

  notice.textContent = enabled ? t('account.stateOn') : t('account.stateOff');
  notice.className = enabled ? 'notice notice-ok' : 'notice notice-warn';

  const parts = [];
  if (enabled) {
    if (me.totp_confirmed_at) {
      parts.push(t('account.since', { date: new Date(me.totp_confirmed_at).toLocaleDateString() }));
    }
    parts.push(t('account.codesLeft', { count: totp.recovery_codes_remaining }));
    if (totp.recovery_codes_remaining === 0) parts.push(t('account.codesGone'));
  } else if (totp.required) {
    // Роль требует второй фактор, но привязки нет: так бывает после сброса
    // администратором. Вход всё равно заставит привязать — говорим об этом
    // прямо, чтобы человек не гадал.
    parts.push(t('account.requiredHint'));
  }
  el('state-detail').textContent = parts.join(' ');

  el('enable').classList.toggle('hidden', enabled);
  el('manage-step').classList.toggle('hidden', !enabled);
  // Обязательный второй фактор снять нельзя — сервер откажет, и кнопку
  // честнее не показывать вовсе, чем показывать неработающую.
  el('disable').classList.toggle('hidden', !enabled || totp.required);

  showStep('state');
}

async function loadMe() {
  const result = await api.get('/api/me');
  me = result.user;
  totp = result.totp || totp;

  el('whoami').textContent = t('admin.whoami', { user: me.username });
  el('admin-link').classList.toggle('hidden', me.role !== 'admin');
  renderState();
}

/* --------------------------------------------------------- привязка */

el('enable').addEventListener('click', (event) =>
  busy(event.currentTarget, async () => {
    showError('');
    try {
      const result = await api.post('/api/totp/enroll');
      el('enroll-secret').textContent = result.secret;
      el('otpauth-link').href = result.otpauth_uri;
      el('enroll-code').value = '';
      showStep('enroll');
      el('enroll-code').focus();
    } catch (err) {
      showError(describe(err));
    }
  })
);

el('copy-secret').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(el('enroll-secret').textContent);
    button.textContent = t('login.copied');
  } catch {
    // Clipboard API работает только в защищённом контексте; секрет всё
    // равно виден и выделяется одним щелчком.
    button.textContent = t('login.copyManually');
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1800);
});

el('cancel-enroll').addEventListener('click', () => {
  showError('');
  renderState();
});

steps.enroll.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  await busy(el('submit-enroll'), async () => {
    try {
      const result = await api.post('/api/totp/confirm', { code: el('enroll-code').value.trim() });
      showRecovery(result.recovery_codes || []);
    } catch (err) {
      showError(describe(err));
      el('enroll-code').select();
    }
  });
});

/* ------------------------------------------ коды восстановления */

function showRecovery(codes) {
  const list = el('recovery-codes');
  list.replaceChildren(
    ...codes.map((code) => {
      const item = document.createElement('li');
      item.textContent = code;
      return item;
    })
  );

  el('copy-recovery').onclick = async (event) => {
    const button = event.currentTarget;
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      button.textContent = t('login.copied');
    } catch {
      button.textContent = t('login.copyManually');
    }
    setTimeout(() => {
      button.textContent = original;
    }, 1800);
  };

  showStep('recovery');
}

el('recovery-done').addEventListener('click', async () => {
  el('manage-code').value = '';
  try {
    await loadMe();
  } catch {
    window.location.assign('/login');
  }
});

/* --------------------------------------- перевыпуск и отключение */

function currentCode() {
  const code = el('manage-code').value.trim();
  if (!code) {
    showError(t('account.codeRequired'));
    el('manage-code').focus();
    return null;
  }
  return code;
}

el('regenerate').addEventListener('click', (event) =>
  busy(event.currentTarget, async () => {
    showError('');
    const code = currentCode();
    if (!code) return;

    try {
      const result = await api.post('/api/totp/recovery-codes', { code });
      el('manage-code').value = '';
      showRecovery(result.recovery_codes || []);
    } catch (err) {
      showError(describe(err));
    }
  })
);

el('disable').addEventListener('click', (event) =>
  busy(event.currentTarget, async () => {
    showError('');
    const code = currentCode();
    if (!code) return;

    try {
      await api.del('/api/totp', { code });
      el('manage-code').value = '';
      toast(t('account.disabled'));
      await loadMe();
    } catch (err) {
      showError(describe(err));
    }
  })
);

/* ------------------------------------------------------------ язык */

function renderLangChips() {
  const row = el('lang-row');
  row.replaceChildren(
    ...LANG_IDS.map((id) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'theme-chip';
      chip.textContent = LANGS[id].label;
      chip.setAttribute('aria-pressed', String(id === getLang()));
      chip.addEventListener('click', () => {
        setLang(id);
        renderLangChips();
        if (me) renderState();
      });
      return chip;
    })
  );
}

renderLangChips();

loadMe().catch(() => window.location.assign('/login'));
