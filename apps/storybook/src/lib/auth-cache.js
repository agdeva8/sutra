/**
 * auth-cache.js — safe localStorage cache helper for cold-start user collapse.
 *
 * Strips tokens/secrets and preserves only safe display fields.
 * All localStorage operations are wrapped in try/catch (best-effort).
 */

export const AUTH_CACHE_KEY = "gc_cached_user";

const SAFE_DISPLAY_FIELDS = [
  "id",
  "user_id",
  "email",
  "name",
  "image",
  "picture",
  "model_provider",
  "is_guest",
  "persona_key",
];

/**
 * Filter out tokens, passwords, sessions, or any secret fields.
 * Preserves only safe display fields.
 *
 * @param {object} user
 * @returns {object|null}
 */
export function sanitizeUserForCache(user) {
  if (!user || typeof user !== "object") return null;

  const sanitized = {};
  for (const field of SAFE_DISPLAY_FIELDS) {
    if (user[field] !== undefined) {
      sanitized[field] = user[field];
    }
  }

  // Normalize id / user_id
  const resolvedId = sanitized.user_id || sanitized.id || null;
  if (!resolvedId) return null;

  sanitized.id = resolvedId;
  sanitized.user_id = resolvedId;

  // Normalize picture / image
  const resolvedPic = sanitized.picture || sanitized.image || null;
  if (resolvedPic) {
    sanitized.picture = resolvedPic;
    sanitized.image = resolvedPic;
  }

  sanitized.is_guest = Boolean(sanitized.is_guest);

  return sanitized;
}

/**
 * Read and validate cached user from localStorage.
 *
 * @returns {object|null}
 */
export function getCachedUser() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return sanitizeUserForCache(parsed);
  } catch {
    return null;
  }
}

/**
 * Write sanitized user to localStorage.
 *
 * @param {object|null} user
 */
export function setCachedUser(user) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    if (!user) {
      window.localStorage.removeItem(AUTH_CACHE_KEY);
      return;
    }
    const safe = sanitizeUserForCache(user);
    if (safe) {
      window.localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(safe));
    } else {
      window.localStorage.removeItem(AUTH_CACHE_KEY);
    }
  } catch {
    // Best-effort write (e.g. storage quota, private browsing)
  }
}

/**
 * Remove cached user from localStorage.
 */
export function clearCachedUser() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.removeItem(AUTH_CACHE_KEY);
  } catch {
    // Best-effort
  }
}

/**
 * Check if the fresh user returned from /api/auth/me differs from the cached user.
 *
 * @param {object|null} cached
 * @param {object|null} fresh
 * @returns {boolean}
 */
export function isDifferentUser(cached, fresh) {
  if (!cached && !fresh) return false;
  if (!cached || !fresh) return true;

  const cachedId = cached.user_id || cached.id;
  const freshId = fresh.user_id || fresh.id;
  if (cachedId !== freshId) return true;

  if ((cached.email || "") !== (fresh.email || "")) return true;
  if ((cached.name || "") !== (fresh.name || "")) return true;
  if (Boolean(cached.is_guest) !== Boolean(fresh.is_guest)) return true;
  if ((cached.model_provider || "") !== (fresh.model_provider || "")) return true;
  if ((cached.persona_key || "") !== (fresh.persona_key || "")) return true;

  const cachedPic = cached.picture || cached.image || "";
  const freshPic = fresh.picture || fresh.image || "";
  if (cachedPic !== freshPic) return true;

  return false;
}
