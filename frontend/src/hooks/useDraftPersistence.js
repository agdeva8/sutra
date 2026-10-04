import { useCallback, useEffect, useState } from "react";

/**
 * Draft persistence for dialogs/forms with meaningful in-progress state.
 *
 * The requirement: an accidental Escape, back-navigation, or reload must not
 * wipe what the user was typing/filling. Drafts live in `sessionStorage`, so
 * they survive reloads / back-forward but clear when the tab or app closes —
 * i.e. "until the user closes the app itself".
 *
 * Two pieces:
 *   - `usePersistentState(key, initial)` — a drop-in `useState` that hydrates
 *     from sessionStorage on mount and writes back on every change. Resetting
 *     to the initial value (what submit handlers usually do) clears the draft.
 *   - `readDraftBucket(kind)` / `writeDraftBucket(kind, id)` — for the chat
 *     surfaces that mint a per-session conversation bucket id; remembering the
 *     id lets a reopened chat load its own transcript instead of a fresh one.
 */

const FORM_PREFIX = "sutra:form-draft:";
const BUCKET_PREFIX = "sutra:chat-draft:";

export function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = sessionStorage.getItem(FORM_PREFIX + key);
      return raw == null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(FORM_PREFIX + key, JSON.stringify(value));
    } catch {
      /* private mode / quota — drafts are best-effort */
    }
  }, [key, value]);

  const clear = useCallback(() => {
    try {
      sessionStorage.removeItem(FORM_PREFIX + key);
    } catch {
      /* ignore */
    }
    setValue(initial);
    // `initial` is intentionally not a dep — callers pass a literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, setValue, clear];
}

export function readDraftBucket(kind) {
  try {
    return sessionStorage.getItem(BUCKET_PREFIX + kind);
  } catch {
    return null;
  }
}

export function writeDraftBucket(kind, id) {
  try {
    sessionStorage.setItem(BUCKET_PREFIX + kind, id);
  } catch {
    /* ignore */
  }
}

export function clearDraftBucket(kind) {
  try {
    sessionStorage.removeItem(BUCKET_PREFIX + kind);
  } catch {
    /* ignore */
  }
}
