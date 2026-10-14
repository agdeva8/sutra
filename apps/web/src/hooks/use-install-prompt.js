import { useCallback, useEffect, useState } from "react";

/**
 * use-install-prompt — detects whether the current browser can offer an
 * "Add to Home Screen / Install app" flow and exposes the controls the
 * InstallPromptDialog needs.
 *
 * Three platforms, three behaviours (this is the whole PWA-install matrix):
 *
 *  1. Chromium (Chrome/Edge, desktop + Android): fires `beforeinstallprompt`
 *     once the manifest installability criteria AND the user-engagement
 *     heuristics (one click + 30s on page) are met. We call `preventDefault()`
 *     to suppress Chrome's mini-infobar (we render our own dialog instead),
 *     hold the event, and replay it when the user taps Install.
 *  2. iOS Safari: no event exists. The only path is manual instructions
 *     (Share → Add to Home Screen), so we offer the instructions variant.
 *     Only Safari can do it — Chrome/Firefox/Edge on iOS have no such menu,
 *     so we don't show instructions there.
 *  3. Everything else (Firefox desktop, etc.): no install path at all —
 *     `canPrompt` stays false and the dialog never opens.
 *
 * Guards:
 *  - Already installed (display-mode standalone / iOS navigator.standalone)
 *    → never prompt again.
 *  - Dismissed → dialog closes, no persistence. Chrome's own anti-spam
 *    (once per ~30 days per site for `beforeinstallprompt`) does the
 *    throttling — a separate localStorage snooze would only add friction
 *    for users who change their mind or are testing. If Chrome ever
 *    fires the event again, we'll show the dialog again.
 */

export function isStandalone() {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
    if (window.navigator?.standalone === true) return true; // iOS Safari
  } catch { /* matchMedia can throw in odd embeddings */ }
  return false;
}

export function isIosSafari() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS
  if (!iOS) return false;
  // Safari is the only iOS browser with Share → Add to Home Screen.
  // crios/fxios/edgios = the other guys.
  return !/crios|fxios|edgiOS|opios/i.test(ua);
}

/* Install-prompt suppression — after the user dismisses, don't show the
 * in-app dialog again for SUPPRESS_MS (one day). The browser's own
 * URL-bar install icon is NOT affected — we only suppress OUR dialog.
 * Keyed in localStorage so it survives reloads. */
const DISMISS_KEY = "sutra_install_dismissed_at";
const SUPPRESS_MS = 24 * 60 * 60 * 1000; // 1 day

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

export default function useInstallPrompt({ showDelayMs = 2500 } = {}) {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(isStandalone);
  const [dismissed, setDismissed] = useState(dismissedRecently);
  const [ready, setReady] = useState(false); // show-delay elapsed

  const iosSafari = isIosSafari();

  useEffect(() => {
    const onBeforeInstall = (e) => {
      // Suppress Chrome's own mini-infobar — the in-app dialog replaces it.
      e.preventDefault();
      setDeferred(e);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Eligible = not installed, not dismissed, and actually capable
  // (Chromium captured a prompt, or iOS Safari). Once dismissed we
  // stay hidden until the browser fires beforeinstallprompt again —
  // Chrome throttles that itself (~once per 30 days per site).
  const eligible = !installed && !dismissed && (deferred !== null || iosSafari);

  useEffect(() => {
    if (!eligible) {
      setReady(false);
      return undefined;
    }
    const t = setTimeout(() => setReady(true), showDelayMs);
    return () => clearTimeout(t);
  }, [eligible, showDelayMs]);

  const promptInstall = useCallback(async () => {
    if (!deferred) return "unavailable";
    deferred.prompt();
    let outcome = "dismissed";
    try {
      const res = await deferred.userChoice;
      outcome = res?.outcome || "dismissed";
    } catch {
      /* user closed the native sheet */
    }
    setDeferred(null);
    if (outcome === "accepted") setInstalled(true);
    else {
      // They said no to the native sheet too — suppress our dialog for a day.
      setDismissed(true);
      markDismissed();
    }
    return outcome;
  }, [deferred]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    // Persist: don't show the in-app dialog again for 24h. The URL-bar
    // install icon is untouched.
    markDismissed();
  }, []);

  return {
    // Dialog opens when the show-delay elapsed AND we can actually do
    // something: Chromium (real prompt) or iOS (instructions).
    open: ready && eligible && (deferred !== null || iosSafari),
    platform: deferred !== null ? "chromium" : iosSafari ? "ios" : "none",
    installed,
    promptInstall,
    dismiss,
  };
}
