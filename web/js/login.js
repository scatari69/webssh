import { ApiError, api } from './common/api.js';
import { FLAVORS, getTheme, initTheme, setTheme } from './common/theme.js';
import { FLAVOR_IDS } from './common/catppuccin.js';
import { LANGS, LANG_IDS, applyStatic, getLang, initI18n, setLang, t } from './common/i18n.js';

initTheme();
initI18n();
applyStatic();

const el = (id) => document.getElementById(id);

const steps = {
  credentials: el('credentials-step'),
  verify: el('verify-step'),
  enroll: el('enroll-step'),
  recovery: el('recovery-step'),
};

const errorBox = el('error');
const subtitle = el('subtitle');

/*
 * Подзаголовок зависит от текущего шага входа, а не от разметки, поэтому
 * applyStatic его не восстановит: храним ключ и перерисовываем сами.
 */
let subtitleKey = 'login.subtitleSignIn';

function setSubtitle(key) {
  subtitleKey = key;
  subtitle.textContent = t(key);
}

function showStep(name) {
  for (const [key, node] of Object.entries(steps)) {
    node.classList.toggle('hidden', key !== name);
  }
  const focusTarget = {
    credentials: 'username',
    verify: 'verify-code',
    enroll: 'enroll-code',
  }[name];
  if (focusTarget) {
    // Мобильная клавиатура должна открыться сразу на нужном поле, но не
    // выдёргивать фокус, если пользователь уже что-то печатает.
    const input = el(focusTarget);
    if (document.activeElement === document.body) input.focus();
  }
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.toggle('hidden', !message);
}

function clearError() {
  showError('');
}

function busy(button, isBusy, label) {
  button.disabled = isBusy;
  if (label !== undefined) button.textContent = label;
}

async function copyText(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = t('login.copied');
  } catch {
    // Clipboard API доступен только в защищённом контексте. Если его нет,
    // выделяем текст: пользователь скопирует сам.
    button.textContent = t('login.copyManually');
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1800);
}

/* --------------------------------------------------------- шаг 1: вход */

steps.credentials.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const username = el('username').value.trim();
  const password = el('password').value;
  if (!username || !password) {
    showError(t('login.fillBoth'));
    return;
  }

  const button = el('submit-credentials');
  busy(button, true, t('login.checking'));

  try {
    const result = await api.post('/api/login', { username, password });

    if (!result.mfa || !result.mfa.required) {
      window.location.assign('/');
      return;
    }

    if (result.mfa.enrolled) {
      setSubtitle('login.subtitleVerify');
      showStep('verify');
    } else {
      await startEnrollment();
    }
  } catch (err) {
    showError(err instanceof ApiError ? err.message : t('login.serverUnavailable'));
  } finally {
    busy(button, false, t('login.submit'));
  }
});

/* ------------------------------------------------ шаг 2: код при входе */

steps.verify.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const code = el('verify-code').value.trim();
  const button = el('submit-verify');
  busy(button, true, t('login.checking'));

  try {
    await api.post('/api/totp/verify', { code });
    window.location.assign('/');
  } catch (err) {
    showError(err instanceof ApiError ? err.message : t('login.serverUnavailable'));
    el('verify-code').select();
  } finally {
    busy(button, false, t('login.verifySubmit'));
  }
});

el('restart-login').addEventListener('click', () => {
  window.location.reload();
});

/* ------------------------------------------------- шаг 3: привязка TOTP */

async function startEnrollment() {
  setSubtitle('login.subtitleEnroll');
  try {
    const result = await api.post('/api/totp/enroll');
    el('enroll-secret').textContent = result.secret;
    const link = el('otpauth-link');
    link.href = result.otpauth_uri;
    showStep('enroll');
  } catch (err) {
    showError(err instanceof ApiError ? err.message : t('login.enrollFailed'));
    showStep('credentials');
  }
}

el('copy-secret').addEventListener('click', (event) => {
  copyText(el('enroll-secret').textContent, event.currentTarget);
});

steps.enroll.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  const code = el('enroll-code').value.trim();
  const button = el('submit-enroll');
  busy(button, true, t('login.checking'));

  try {
    const result = await api.post('/api/totp/confirm', { code });
    renderRecoveryCodes(result.recovery_codes || []);
  } catch (err) {
    showError(err instanceof ApiError ? err.message : t('login.serverUnavailable'));
    el('enroll-code').select();
  } finally {
    busy(button, false, t('login.enrollSubmit'));
  }
});

/* --------------------------------------- шаг 4: коды восстановления */

function renderRecoveryCodes(codes) {
  const list = el('recovery-codes');
  list.replaceChildren(
    ...codes.map((code) => {
      const item = document.createElement('li');
      item.textContent = code;
      return item;
    })
  );

  el('copy-recovery').onclick = (event) => copyText(codes.join('\n'), event.currentTarget);

  setSubtitle('login.subtitleRecovery');
  showStep('recovery');
}

el('recovery-done').addEventListener('click', () => {
  window.location.assign('/');
});

/* ------------------------------------------------------------- темы */

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
        // Подзаголовок зависит от текущего шага, а не от разметки, —
        // applyStatic его не восстановит.
        subtitle.textContent = t(subtitleKey);
      });
      return chip;
    })
  );
}

function renderThemeChips() {
  const row = el('theme-row');
  row.replaceChildren(
    ...FLAVOR_IDS.map((id) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'theme-chip';
      chip.textContent = FLAVORS[id].label;
      chip.setAttribute('aria-pressed', String(id === getTheme()));
      chip.addEventListener('click', () => {
        setTheme(id);
        renderLangChips();
renderThemeChips();
      });
      return chip;
    })
  );
}

renderLangChips();
renderThemeChips();

// Проверять здесь наличие живой сессии незачем: сервер сам уводит
// вошедшего с /login в терминал. Лишний запрос только оставлял бы в
// консоли браузера ошибку 401 на каждом открытии формы.
showStep('credentials');
