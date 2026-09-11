// Имя, указанное при регистрации, запоминаем в браузере, чтобы при следующем
// входе поздороваться лично. Хранится только локально и не уходит на сервер.
const KEY = 'voicyfy_first_name';

export function rememberFirstName(name) {
  try {
    const clean = String(name || '').trim();
    if (clean) localStorage.setItem(KEY, clean.slice(0, 40));
  } catch (e) { /* приватный режим или заблокированное хранилище */ }
}

export function getRememberedFirstName() {
  try {
    return (localStorage.getItem(KEY) || '').trim();
  } catch (e) {
    return '';
  }
}
