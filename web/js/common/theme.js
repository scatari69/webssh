import { DEFAULT_FLAVOR, FLAVORS, toCssVariables, toXtermTheme } from './catppuccin.js';

const STORAGE_KEY = 'webssh.theme';

const listeners = new Set();
let current = DEFAULT_FLAVOR;

function readStored() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && FLAVORS[stored] ? stored : DEFAULT_FLAVOR;
  } catch {
    // localStorage бывает недоступен: приватный режим, отключённые cookie.
    // Тема не тот повод, чтобы из-за этого падать.
    return DEFAULT_FLAVOR;
  }
}

function applyCss(flavorId) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(toCssVariables(flavorId))) {
    root.style.setProperty(name, value);
  }
  root.dataset.flavor = flavorId;
  // Сообщаем браузеру, светлая тема или тёмная, — от этого зависит вид
  // системных элементов: полос прокрутки и, на мобильном, панелей.
  root.style.colorScheme = FLAVORS[flavorId].dark ? 'dark' : 'light';

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', FLAVORS[flavorId].colors.crust);
}

export function getTheme() {
  return current;
}

export function setTheme(flavorId) {
  if (!FLAVORS[flavorId]) return;
  current = flavorId;
  applyCss(flavorId);
  try {
    localStorage.setItem(STORAGE_KEY, flavorId);
  } catch {
    // Не сохранилось — тема просто не переживёт перезагрузку.
  }
  for (const listener of listeners) listener(flavorId, toXtermTheme(flavorId));
}

/** @param {(flavorId: string, xtermTheme: object) => void} listener */
export function onThemeChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Применяет сохранённую тему. Вызывается как можно раньше на каждой странице. */
export function initTheme() {
  current = readStored();
  applyCss(current);
  return current;
}

export { FLAVORS, toXtermTheme };
