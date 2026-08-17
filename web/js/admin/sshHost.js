/**
 * Единственный SSH-хост приложения: текущее состояние и форма правки.
 *
 * Ключ и passphrase сюда никогда не приходят — API их не отдаёт. Поэтому
 * форма работает в трёх положениях: поле пустое — «не менять», заполнено —
 * «заменить», галочка — «убрать». Иначе сохранить адрес, не трогая ключ,
 * было бы невозможно.
 */

import { api } from '../common/api.js';
import { confirmAction, el, formatDateTime, node, reportError, toast, withBusy } from './ui.js';

/** Ключи бывают до нескольких килобайт; всё, что крупно, — не ключ. */
const MAX_KEY_BYTES = 64 * 1024;

let current = null;

function row(list, term, value) {
  list.append(node('dt', null, term));
  list.append(value instanceof Node ? value : node('dd', null, value));
}

function valueNode(text, className) {
  return node('dd', className, text);
}

function renderStatus(cfg) {
  const list = el('ssh-status');
  list.replaceChildren();

  if (cfg.is_configured) {
    row(list, 'Адрес', valueNode(`${cfg.ssh_username}@${cfg.host}:${cfg.port}`, 'mono'));
  } else {
    const dd = node('dd');
    dd.append(node('span', 'chip chip-warn', 'не настроен'));
    dd.append(
      document.createTextNode(
        cfg.host ? ` ${cfg.ssh_username}@${cfg.host}:${cfg.port} — не хватает ключа` : ' — терминал недоступен всем'
      )
    );
    row(list, 'Адрес', dd);
  }

  if (cfg.has_private_key) {
    row(list, 'Ключ', valueNode(`${cfg.private_key_type || 'неизвестный тип'} · ${cfg.private_key_fingerprint || '—'}`, 'mono'));
  } else {
    row(list, 'Ключ', valueNode('не загружен'));
  }

  row(list, 'Passphrase', valueNode(cfg.has_passphrase ? 'задана' : 'нет'));

  // Проверка ключа хоста — единственное, что стоит между приложением и
  // подменой сервера, поэтому её состояние видно, а не спрятано.
  const policy = {
    tofu: 'запоминается при первом подключении',
    pinned: 'сверяется строго',
    insecure: 'не проверяется',
  }[cfg.host_key_policy] || cfg.host_key_policy;
  const hostKey = node('dd');
  hostKey.append(document.createTextNode(`${cfg.host_key_policy} — ${policy}`));
  if (cfg.known_host_fingerprint) {
    hostKey.append(node('div', 'mono', cfg.known_host_fingerprint));
  } else {
    hostKey.append(node('div', 'field-hint', 'ключ хоста ещё не запомнен'));
  }
  row(list, 'Ключ хоста', hostKey);

  row(
    list,
    'Обновлено',
    valueNode(
      cfg.updated_at
        ? `${formatDateTime(cfg.updated_at)}${cfg.updated_by ? `, ${cfg.updated_by}` : ''}`
        : '—'
    )
  );
}

function fillForm(cfg) {
  el('ssh-host').value = cfg.host || '';
  el('ssh-port').value = cfg.port || 22;
  el('ssh-username').value = cfg.ssh_username || '';
  el('ssh-key-text').value = '';
  el('ssh-key-file').value = '';
  el('ssh-passphrase').value = '';
  el('ssh-passphrase-clear').checked = false;
  el('ssh-passphrase').disabled = false;
}

async function load() {
  try {
    const { ssh_config: cfg } = await api.get('/api/admin/ssh-config');
    current = cfg;
    renderStatus(cfg);
    fillForm(cfg);
  } catch (err) {
    reportError(err);
  }
}

/* ------------------------------------------------- загрузка файла */

function bindFileInput() {
  const file = el('ssh-key-file');
  const text = el('ssh-key-text');

  file.addEventListener('change', async () => {
    const chosen = file.files && file.files[0];
    if (!chosen) return;

    if (chosen.size > MAX_KEY_BYTES) {
      toast('Файл слишком велик для приватного ключа.');
      file.value = '';
      return;
    }

    try {
      const content = await chosen.text();
      text.value = content;
      if (!/BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(content)) {
        // Самая частая ошибка — выбрать рядом лежащий .pub. Сказать об этом
        // сразу полезнее, чем дать серверу ответить «ключ не разобран».
        toast('Не похоже на приватный ключ — проверьте, не выбран ли публичный (.pub).');
      } else {
        toast(`Ключ загружен из «${chosen.name}»`);
      }
    } catch {
      toast('Не удалось прочитать файл.');
      file.value = '';
    }
  });
}

/* ---------------------------------------------------- сохранение */

function collectPayload() {
  const port = Number(el('ssh-port').value);
  const payload = {
    host: el('ssh-host').value.trim(),
    port,
    ssh_username: el('ssh-username').value.trim(),
  };

  const key = el('ssh-key-text').value.trim();
  if (key) payload.private_key = key;

  if (el('ssh-passphrase-clear').checked) payload.passphrase = null;
  else if (el('ssh-passphrase').value) payload.passphrase = el('ssh-passphrase').value;

  return payload;
}

/**
 * Предупреждения строятся по тому, что реально меняется: подтверждение,
 * которое всегда говорит одно и то же, перестают читать.
 */
function describeConsequences(payload) {
  const warnings = [];

  if (payload.private_key && current && current.has_private_key) {
    warnings.push(
      'Сохранённый приватный ключ будет заменён безвозвратно — прежний нигде не хранится ' +
        'и восстановить его отсюда нельзя.'
    );
  }

  const movedHost =
    current && (payload.host !== current.host || payload.port !== current.port);
  if (movedHost && current.known_host_fingerprint) {
    warnings.push(
      'Адрес меняется, поэтому запомненный ключ хоста будет сброшен: ключ нового сервера ' +
        'примется при первом подключении без сверки.'
    );
  }

  if (payload.passphrase === null && current && current.has_passphrase) {
    warnings.push('Сохранённая passphrase будет удалена.');
  }

  return warnings;
}

function bindForm() {
  const form = el('ssh-form');

  el('ssh-passphrase-clear').addEventListener('change', (event) => {
    // «Убрать» и «задать» — взаимоисключающие намерения.
    const clearing = event.currentTarget.checked;
    el('ssh-passphrase').disabled = clearing;
    if (clearing) el('ssh-passphrase').value = '';
  });

  el('ssh-reset').addEventListener('click', () => {
    if (current) fillForm(current);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = collectPayload();

    if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) {
      toast('Порт должен быть числом от 1 до 65535.');
      return;
    }

    const warnings = describeConsequences(payload);
    if (warnings.length) {
      const confirmed = await confirmAction({
        title: 'Изменить настройки хоста?',
        message: `${warnings.join(' ')} Изменение затронет всех пользователей приложения сразу.`,
        confirmLabel: 'Сохранить',
      });
      if (!confirmed) return;
    }

    await withBusy(el('ssh-submit'), async () => {
      try {
        const { ssh_config: cfg } = await api.put('/api/admin/ssh-config', payload);
        current = cfg;
        renderStatus(cfg);
        fillForm(cfg);
        toast('Настройки хоста сохранены');
        onChanged();
      } catch (err) {
        reportError(err);
      }
    });
  });
}

let onChanged = () => {};

export function initSshHost({ onChange }) {
  if (onChange) onChanged = onChange;

  bindFileInput();
  bindForm();
  el('ssh-refresh').addEventListener('click', (event) => withBusy(event.currentTarget, load));

  return load();
}
