import { api } from "./api";

/**
 * Theme and text size, kept on the account so they follow the user across devices.
 * localStorage stays as the pre-paint cache (index.html reads it before React mounts).
 *
 * Migration on read: an account with nothing saved yet adopts this browser's values, which may sit under
 * either the current key (`sutra_theme`) or the older one (`gc_theme`); the old key is then removed.
 */
const THEME_KEY = "sutra_theme";
const LEGACY_THEME_KEY = "gc_theme";
const FONT_KEY = "sutra_font_size";

const read = (k) => {
  try { return window.localStorage.getItem(k); } catch { return null; }
};
const write = (k, v) => {
  try { window.localStorage.setItem(k, v); } catch { /* storage blocked: the account copy still holds */ }
};

function apply({ theme, font_size: fontSize }) {
  if (theme) {
    document.documentElement.classList.toggle("light", theme === "light");
    write(THEME_KEY, theme);
  }
  if (fontSize) {
    document.documentElement.style.setProperty("--sutra-font-scale", `${fontSize}px`);
    write(FONT_KEY, String(fontSize));
  }
}

/** Save a change (fire and forget; the local copy already took effect). */
export function saveDisplayPrefs(patch) {
  api.putDisplayPrefs(patch).catch(() => {});
}

/** Load the account's preferences, or upload this browser's the first time. */
export async function syncDisplayPrefs() {
  let saved;
  try {
    saved = (await api.displayPrefs())?.display || {};
  } catch {
    return;
  }
  if (saved.theme || saved.font_size) {
    apply(saved);
    return;
  }
  const theme = read(THEME_KEY) || read(LEGACY_THEME_KEY);
  const size = parseInt(read(FONT_KEY) || "", 10);
  const local = {};
  if (theme === "light" || theme === "dark") local.theme = theme;
  if (Number.isFinite(size)) local.font_size = size;
  if (Object.keys(local).length) saveDisplayPrefs(local);
  try { window.localStorage.removeItem(LEGACY_THEME_KEY); } catch { /* ignore */ }
}
