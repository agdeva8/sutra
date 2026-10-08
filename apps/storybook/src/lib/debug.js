/**
 * debug.js — in-app debug mode for mobile testing.
 *
 * Everything here is opt-in and invisible to normal users:
 *
 *  - `isDebugMode()` reads the URL param / localStorage flag. Open the app
 *    with `?debug=1` once — the flag persists in localStorage so the debug
 *    console survives reloads and the installed home-screen PWA (URL is
 *    lost there). `?debug=0` turns it off.
 *  - `initDebug()` must run BEFORE React renders: it installs the always-on
 *    error ring buffer (keeps the last N errors + failed fetches even with
 *    the console closed), and lazily injects eruda — a full on-device
 *    console (console / network / elements / storage) — when the flag is on.
 *  - `DevInfo`/`DebugPanel` (components/DevDiagnostics) consume the ring
 *    buffer for the Developer section in Settings.
 *
 * The buffer is always recording so post-mortems work: if the app breaks
 * on the phone *without* debug mode on, turn on debug mode afterwards and
 * the captured errors are still there.
 */

// ─── Debug mode detection ────────────────────────────────────────────────

const DEBUG_FLAG_KEY = "sutra_debug_mode";

/** Module-level, resolved once at init. Read with isDebugMode(). */
let _debugMode = false;

function readFlag() {
  try {
    return localStorage.getItem(DEBUG_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFlag(value) {
  try {
    if (value) localStorage.setItem(DEBUG_FLAG_KEY, "1");
    else localStorage.removeItem(DEBUG_FLAG_KEY);
  } catch { /* private mode — flag just won't persist */ }
}

/**
 * Resolve debug mode from the URL first (explicit wins over the stored
 * flag), then fall back to storage. Call once from initDebug().
 */
function resolveMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const explicit = params.get("debug");
    if (explicit === "1" || explicit === "true") {
      writeFlag(true);
      return true;
    }
    // `?debug=0` = explicit OFF (clears the persisted flag too)
    if (explicit === "0" || explicit === "false") {
      writeFlag(false);
      return false;
    }
  } catch { /* URLSearchParams unavailability is fairy-tale territory */ }
  return readFlag();
}

export function isDebugMode() {
  return _debugMode;
}

/**
 * Persist the debug flag. Enabling requires a reload for the console to
 * attach (initDebug runs once), so callers reload; disabling destroys eruda
 * immediately and also expects a reload to drop the Settings tab.
 */
export function setDebugMode(enabled) {
  writeFlag(!!enabled);
  if (!enabled && typeof window !== "undefined" && erudaLoaded) {
    import(/* webpackChunkName: "eruda" */ "eruda")
      .then((mod) => (mod.default || mod).destroy?.())
      .catch(() => {});
  }
}

// ─── Error ring buffer (always on) ───────────────────────────────────────

const BUFFER_LIMIT = 40;
const buffer = [];
const listeners = new Set();

function push(entry) {
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.shift();
  listeners.forEach((fn) => {
    try { fn(entry); } catch { /* a dead listener must not break others */ }
  });
}

/** Subscribe to live entries (used by the DevDiagnostics panel). */
export function onDebugEntry(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Snapshot of everything captured so far (newest last). */
export function getDebugEntries() {
  return buffer.slice();
}

export function clearDebugEntries() {
  buffer.length = 0;
}

/** Text dump for the "copy diagnostics" button. */
export function formatDebugEntries() {
  if (!buffer.length) return "(no entries captured)";
  return buffer
    .map((e) => `[${e.at}][${e.level}] ${e.message}${e.detail ? `\n    ${e.detail}` : ""}`)
    .join("\n");
}

const LEVELS = { error: "error", warn: "warn" };

function fmt(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(" ");
}

function installErrorBuffer() {
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.error = (...args) => {
    push({
      level: LEVELS.error,
      message: args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ").slice(0, 200),
      detail: fmt(args).slice(0, 2000),
      at: new Date().toLocaleTimeString(),
    });
    origError(...args);
  };
  console.error.orig = origError;

  console.warn = (...args) => {
    push({
      level: LEVELS.warn,
      message: String(args[0] instanceof Error ? args[0].message : args[0] ?? "").slice(0, 200),
      detail: fmt(args).slice(0, 2000),
      at: new Date().toLocaleTimeString(),
    });
    origWarn(...args);
  };
  console.warn.orig = origWarn;

  window.addEventListener("error", (e) => {
    // script errors + failed resource loads that bubbled to window
    push({
      level: LEVELS.error,
      message: (e.message || "Script error").slice(0, 200),
      detail: [e.filename && `at ${e.filename}:${e.lineno}`, e.error?.stack]
        .filter(Boolean)
        .join("\n    ")
        .slice(0, 2000),
      at: new Date().toLocaleTimeString(),
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason instanceof Error ? e.reason : new Error(String(e.reason ?? "unknown"));
    push({
      level: LEVELS.error,
      message: `Unhandled promise rejection: ${reason.message}`.slice(0, 200),
      detail: reason.stack?.slice(0, 2000),
      at: new Date().toLocaleTimeString(),
    });
  });
}

// ─── eruda — on-device console (only when the flag is on) ────────────────

let erudaLoaded = false;

export function loadEruda() {
  if (erudaLoaded || typeof window === "undefined") return;
  erudaLoaded = true;
  // Local webpack-chunked import — only this wiring is statically pulled in;
  // eruda's ~200 kB lands in its own lazy chunk, fetched only when the flag
  // is on. import() must stay literal for webpack code-splitting.
  import(/* webpackChunkName: "eruda" */ "eruda")
    .then((mod) => {
      const eruda = mod.default || mod;
      eruda.init();
      eruda.position({ x: 20, y: 60 }); // thumb-reachable, off the notch
      // (eruda wraps console after our wrapper — ours is outermost, so both
      //  the ring buffer and eruda's UI capture everything.)
    })
    .catch(() => { /* eruda failed to load — the ring buffer still works */ });
}

// ─── Init ─────────────────────────────────────────────────────────────────

let initialized = false;

export function initDebug() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  _debugMode = resolveMode();

  installErrorBuffer();

  if (_debugMode) loadEruda();
}
