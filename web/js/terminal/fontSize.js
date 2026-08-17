/**
 * Размер шрифта терминала.
 *
 * Значение по умолчанию на касании больше, чем на десктопе, а не меньше:
 * телефон держат дальше от глаз, чем монитор, и пиксель на нём мельче.
 * Раньше здесь было наоборот — 13 против 14, — и на телефоне текст выходил
 * заметно мельче настольного.
 *
 * Ширина в колонках при этом остаётся рабочей: 15px моноширинного шрифта на
 * экране 390px дают примерно 43 колонки. Восьмидесяти на телефоне не будет
 * ни при каком размере, поэтому выбор идёт между «мелко» и «читаемо».
 */

const STORAGE_KEY = 'webssh.fontSize';

export const MIN_SIZE = 10;
export const MAX_SIZE = 24;

const listeners = new Set();
let current = 14;

function clamp(size) {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size)));
}

export function defaultFor(isTouch) {
  return isTouch ? 15 : 14;
}

export function getFontSize() {
  return current;
}

export function setFontSize(size) {
  const next = clamp(size);
  if (next === current) return current;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Не сохранилось — размер просто не переживёт перезагрузку.
  }
  for (const listener of listeners) listener(next);
  return next;
}

export function stepFontSize(delta) {
  return setFontSize(current + delta);
}

export function canGrow() {
  return current < MAX_SIZE;
}

export function canShrink() {
  return current > MIN_SIZE;
}

/** @param {(size: number) => void} listener */
export function onFontSizeChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Читает сохранённый размер; при его отсутствии — значение для устройства. */
export function initFontSize(isTouch) {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage недоступен: приватный режим, отключённые cookie.
  }

  const parsed = stored === null ? NaN : Number(stored);
  current = Number.isFinite(parsed) ? clamp(parsed) : defaultFor(isTouch);
  return current;
}
