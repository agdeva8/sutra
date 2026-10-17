import { useEffect, useState } from "react";

/**
 * install.js — PWA install: one shared store, plus the hooks that read it.
 *
 * `beforeinstallprompt` can fire the moment the page loads, before React has
 * mounted anything, so the state lives at module level and is wired up in
 * index.js (`initInstall()`) rather than in a component. Every consumer — the
 * top-bar Install button, the automatic install sheet, the Developer
 * diagnostics — reads the same held event; a second copy of the listener in a
 * second component would miss the event entirely, which is why this is a store
 * and not a hook local to the sheet.
 *
 * Three platforms, three behaviours (the whole PWA-install matrix):
 *
 *  1. Chromium (Chrome / Edge, desktop + Android): fires `beforeinstallprompt`
 *     once the manifest installability criteria AND the engagement heuristics
 *     are met. We call `preventDefault()` to suppress Chrome's own mini-infobar
 *     (we render our own sheet instead), hold the event, and replay it when the
 *     user taps Install.
 *  2. Android Chromium before that event (criteria unmet, or Chrome throttling
 *     its own prompt) — there is nothing to replay, so we point the user at the
 *     browser's overflow menu instead.
 *  3. iOS: no event exists. The only path is the Share sheet's "Add to Home
 *     Screen", which Safari always carries and Chrome / Edge carry on iOS 16.4+.
 *     The other iOS browsers have no such item, so we offer no steps there.
 *
 * Guards:
 *  - Installed already (any standalone-ish display-mode, or iOS
 *    `navigator.standalone`) → never offer again.
 *  - Dismissed → the automatic sheet stays away for a day. Chrome's own
 *    anti-spam throttles the event itself (~once per 30 days per site). The
 *    top-bar button ignores the snooze — it is the deliberate way back in.
 */

// ─── Platform ────────────────────────────────────────────────────────────

/** What a tap on the install affordance should do, per browser. */
export const INSTALL_PLATFORM = {
  CHROMIUM: "chromium", // a real beforeinstallprompt is in hand → native prompt
  ANDROID: "android", // Android Chromium, no prompt yet → menu steps
  IOS: "ios", // share-sheet steps
  NONE: "none", // no install path in this browser
};

/* Display modes that mean "already running as an installed app". `appinstalled`
 * fires too, but a reload straight into the standalone window would otherwise
 * re-offer the button, so every mode counts. */
const STANDALONE_DISPLAY_MODES = ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"];

/** The iOS version that gave Chrome and Edge "Add to Home Screen" in the Share sheet. */
const MIN_IOS_SHARE_SHEET = { major: 16, minor: 4 };

/** The iOS browsers that carry the Share-sheet item (Safari is handled apart). */
const IOS_SHARE_SHEET_BROWSERS = /crios|edgios/i;

// ─── Snooze storage ──────────────────────────────────────────────────────

/* After the user dismisses the automatic sheet, leave it alone for a day.
 * Only OUR sheet is suppressed — the browser's own install icon is not. */
const DISMISS_KEY = "sutra_install_dismissed_at";
const SUPPRESS_MS = 24 * 60 * 60 * 1000; // 1 day

/** How long the automatic sheet waits after load before appearing. */
const INSTALL_SHEET_DELAY_MS = 2500;

// ─── Environment detection ───────────────────────────────────────────────

/** True while the app runs as an installed PWA rather than a browser tab. */
export function isStandalone() {
  if (typeof window === "undefined") return false;
  try {
    if (STANDALONE_DISPLAY_MODES.some((mode) => window.matchMedia?.(`(display-mode: ${mode})`)?.matches)) return true;
    if (window.navigator?.standalone === true) return true; // iOS Safari
  } catch { /* matchMedia can throw in odd embeddings */ }
  return false;
}

/** Any iOS browser — including iPadOS, which reports a Mac user agent. */
function isIos() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** iOS Safari — the one iOS browser that always offers Share → Add to Home Screen. */
export function isIosSafari() {
  if (!isIos()) return false;
  return !/crios|fxios|edgios|opios/i.test(navigator.userAgent || "");
}

/** The iOS version as { major, minor }, or null when it can't be read. */
function iosVersion() {
  const m = /OS (\d+)[._](\d+)/.exec(navigator.userAgent || "");
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** Whether this iOS browser's Share sheet carries "Add to Home Screen". */
function iosCanInstall() {
  if (!isIos()) return false;
  if (isIosSafari()) return true;
  if (!IOS_SHARE_SHEET_BROWSERS.test(navigator.userAgent || "")) return false;
  const v = iosVersion();
  if (!v) return false;
  return (
    v.major > MIN_IOS_SHARE_SHEET.major ||
    (v.major === MIN_IOS_SHARE_SHEET.major && v.minor >= MIN_IOS_SHARE_SHEET.minor)
  );
}

/** Chromium on Android — the browsers whose overflow menu installs the app. */
function isAndroidChromium() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Android/i.test(ua) && /Chrome|Chromium|EdgA|SamsungBrowser|OPR/i.test(ua);
}

// ─── The store ───────────────────────────────────────────────────────────

let deferredPrompt = null; // the held `beforeinstallprompt` event, if any
let installed = false;
let dismissed = false;
let initialized = false;

const listeners = new Set();

function emit() {
  listeners.forEach((fn) => fn());
}

/** Which install path this browser offers right now. */
function detectPlatform() {
  if (installed) return INSTALL_PLATFORM.NONE;
  if (deferredPrompt) return INSTALL_PLATFORM.CHROMIUM;
  if (iosCanInstall()) return INSTALL_PLATFORM.IOS;
  if (isAndroidChromium()) return INSTALL_PLATFORM.ANDROID;
  return INSTALL_PLATFORM.NONE;
}

function storeSnapshot() {
  return {
    installed,
    canPrompt: deferredPrompt !== null,
    platform: detectPlatform(),
    dismissed,
  };
}

/** Read-only view of the store, for tests and diagnostics. */
export function getInstallState() {
  return storeSnapshot();
}

function dismissedRecently() {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY)) || 0;
    return at > 0 && Date.now() - at < SUPPRESS_MS;
  } catch {
    return false;
  }
}

function markDismissed() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
}

/**
 * Replay the held native prompt and report the browser's answer.
 *
 * Returns "unavailable" when no event is held — the caller then falls back to
 * the menu / share-sheet instructions rather than doing nothing.
 */
async function promptInstall() {
  const event = deferredPrompt;
  if (!event) return "unavailable";
  event.prompt();
  let outcome = "dismissed";
  try {
    const res = await event.userChoice;
    outcome = res?.outcome || "dismissed";
  } catch { /* the user closed the native sheet */ }
  deferredPrompt = null;
  if (outcome === "accepted") installed = true;
  else {
    // They said no to the native sheet too — snooze our own sheet for a day.
    dismissed = true;
    markDismissed();
  }
  emit();
  return outcome;
}

/** Close the automatic sheet and snooze it for a day. */
function dismissInstall() {
  dismissed = true;
  markDismissed();
  emit();
}

/**
 * Wire the store to the browser. Runs before the first render (see index.js) so
 * a `beforeinstallprompt` fired during startup is not missed. Idempotent.
 */
export function initInstall() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  installed = isStandalone();
  dismissed = dismissedRecently();

  window.addEventListener("beforeinstallprompt", (event) => {
    // Suppress Chrome's own mini-infobar — our sheet replaces it.
    event.preventDefault();
    deferredPrompt = event;
    emit();
  });

  window.addEventListener("appinstalled", () => {
    installed = true;
    deferredPrompt = null;
    emit();
  });

  // An install can also happen without `appinstalled` (a reload straight into
  // the standalone window) — watch the display-mode queries for that.
  STANDALONE_DISPLAY_MODES.forEach((mode) => {
    window.matchMedia?.(`(display-mode: ${mode})`)?.addEventListener?.("change", () => {
      installed = isStandalone();
      emit();
    });
  });
}

// ─── Hooks ───────────────────────────────────────────────────────────────

/** Subscribe a component to the store. Internal — the hooks below are the surface. */
function useInstallState() {
  const [snapshot, setSnapshot] = useState(storeSnapshot);
  useEffect(() => {
    const sync = () => setSnapshot(storeSnapshot());
    listeners.add(sync);
    sync();
    return () => listeners.delete(sync);
  }, []);
  return { ...snapshot, prompt: promptInstall, dismiss: dismissInstall };
}

/**
 * The install capability, for the top-bar Install button.
 *
 *   installed — already running as an installed app (hide the button)
 *   canPrompt — a native prompt is held; `prompt()` opens it
 *   platform  — INSTALL_PLATFORM.* telling the caller what a tap should do
 *   prompt()  — replay the native prompt; "unavailable" when there is none
 */
export function useInstall() {
  const { installed, canPrompt, platform, prompt } = useInstallState();
  return { installed, canPrompt, platform, prompt };
}

/**
 * The automatic sheet's view: `open` once it is worth showing (not installed,
 * not snoozed, and an install path exists) and the show-delay has elapsed.
 */
export function useInstallPrompt({ showDelayMs = INSTALL_SHEET_DELAY_MS } = {}) {
  const { installed, canPrompt, platform, dismissed, prompt, dismiss } = useInstallState();
  const [ready, setReady] = useState(false); // show-delay elapsed

  // Eligible = not installed, not snoozed, and actually capable (Chromium
  // captured a prompt, or the iOS Share sheet can install). Once snoozed we
  // stay hidden until the browser fires `beforeinstallprompt` again — Chrome
  // throttles that itself. Android's menu path is the button's job, not ours.
  const eligible = !installed && !dismissed && (canPrompt || platform === INSTALL_PLATFORM.IOS);

  useEffect(() => {
    if (!eligible) {
      setReady(false);
      return undefined;
    }
    const t = setTimeout(() => setReady(true), showDelayMs);
    return () => clearTimeout(t);
  }, [eligible, showDelayMs]);

  return {
    open: ready && eligible,
    platform: canPrompt
      ? INSTALL_PLATFORM.CHROMIUM
      : platform === INSTALL_PLATFORM.IOS
        ? INSTALL_PLATFORM.IOS
        : INSTALL_PLATFORM.NONE,
    promptInstall: prompt,
    dismiss,
  };
}
