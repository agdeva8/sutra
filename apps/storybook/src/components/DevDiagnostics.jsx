import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  Bug,
  ClipboardCopy,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { API } from "../lib/api";
import {
  clearDebugEntries,
  formatDebugEntries,
  getDebugEntries,
  onDebugEntry,
} from "../lib/debug";
import { isIosSafari, isStandalone } from "../hooks/use-install-prompt";
import pkg from "../../package.json";

// Same iOS grouped-inset vocabulary as the rest of Settings (see
// pages/Settings.jsx) so the Developer section doesn't look bolted on.
const INSET_LIST = "rounded-2xl bg-[var(--bg-secondary)] overflow-hidden divide-y divide-[var(--border)]";
const INSET_ROW =
  "w-full flex items-center justify-between gap-3 px-4 py-3 text-left text-sm " +
  "text-[var(--text-primary)]";
const GROUP_LABEL = "px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]";
const ACTION_BTN =
  "w-full flex items-center gap-2.5 px-4 py-3.5 text-left text-sm font-medium " +
  "transition-colors hover:bg-[var(--bg-tertiary)] active:bg-[var(--bg-tertiary)] disabled:opacity-60";

/** Short platform label — enough to know which mobile browser we're on. */
function platformLabel() {
  try {
    const ua = navigator.userAgent || "";
    if (isIosSafari()) return "iOS Safari";
    if (/crios/i.test(ua)) return "iOS Chrome";
    if (/android/i.test(ua)) return `Android · ${/Chrome\//.test(ua) ? "Chrome" : "browser"}`;
    return navigator.platform || "Desktop";
  } catch {
    return "unknown";
  }
}

function themeLabel() {
  try {
    return document.documentElement.classList.contains("light") ? "light" : "dark";
  } catch {
    return "unknown";
  }
}

/** Static info captured at mount; cheap, no async. */
function collectInfo(user) {
  let dpr = 1;
  try { dpr = window.devicePixelRatio || 1; } catch { /* ignore */ }
  return {
    backend: API || "(same origin)",
    build: `v${pkg.version}`,
    mode: isStandalone() ? "PWA (installed)" : "Browser tab",
    platform: platformLabel(),
    viewport: `${window.innerWidth}×${window.innerHeight} @${dpr}x`,
    theme: themeLabel(),
    online: navigator.onLine ? "online" : "offline",
    session: user?.is_guest ? "guest" : user?.email || "not signed in",
  };
}

function InfoRow({ label, value, mono = true }) {
  return (
    <div className={`${INSET_ROW} gap-4`}>
      <span className="text-[var(--text-muted)] shrink-0">{label}</span>
      <span className={`min-w-0 text-right ${mono ? "font-mono text-[11px] text-[var(--text-secondary)] break-all" : ""}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * Developer section for Settings — rendered only when debug mode is on
 * (see lib/debug.js). Three things to answer "is anything wrong?" on a
 * phone where there is no console:
 *
 *  1. Environment — which build, which backend, installed or browser,
 *     theme / viewport / SW state.
 *  2. Backend health — one raw request to `/auth/me`, reporting the real
 *     HTTP status and round-trip time.
 *  3. Recent errors — the always-on ring buffer (window errors, unhandled
 *     rejections, console.error/warn), newest first.
 */
export default function DevDiagnostics({ user, onDisable }) {
  const [entries, setEntries] = useState(() => getDebugEntries());
  const [probe, setProbe] = useState(null); // { status, ok, ms, error }
  const [probing, setProbing] = useState(false);
  const [swScope, setSwScope] = useState(undefined); // undefined = checking, null = none

  // Live-append new log entries while this section is mounted.
  useEffect(() => onDebugEntry(() => setEntries(getDebugEntries())), []);

  useEffect(() => {
    let cancelled = false;
    if (!("serviceWorker" in navigator)) {
      setSwScope(null);
      return undefined;
    }
    navigator.serviceWorker.getRegistration()
      .then((r) => { if (!cancelled) setSwScope(r?.scope || null); })
      .catch(() => { if (!cancelled) setSwScope(null); });
    return () => { cancelled = true; };
  }, []);

  const info = useMemo(() => collectInfo(user), [user]);
  const newestFirst = useMemo(() => entries.slice().reverse(), [entries]);

  const runProbe = useCallback(async () => {
    if (probing) return;
    setProbing(true);
    const t0 = performance.now();
    try {
      const res = await fetch(`${API}/auth/me`, { credentials: "include" });
      setProbe({ status: res.status, ok: res.ok, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      setProbe({ ok: false, error: e?.message || "network error", ms: Math.round(performance.now() - t0) });
    } finally {
      setProbing(false);
    }
  }, [probing]);

  const copyAll = useCallback(async () => {
    const summary = [
      "Sutra diagnostics",
      ...Object.entries(info).map(([k, v]) => `${k}: ${v}`),
      `serviceWorker: ${swScope ?? "none"}`,
      probe
        ? `probe: ${probe.ok ? `HTTP ${probe.status}` : "FAILED"} in ${probe.ms}ms${probe.error ? ` (${probe.error})` : ""}`
        : "probe: not run",
      "",
      "Recent log:",
      formatDebugEntries(),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(summary);
      toast.success("Diagnostics copied");
    } catch {
      toast.error("Clipboard blocked — long-press to copy instead");
    }
  }, [info, probe, swScope]);

  const clearCacheAndReload = useCallback(async () => {
    if (!window.confirm("Clear cached files and service worker, then reload?")) return;
    try {
      if ("caches" in window) {
        const keys = await window.caches.keys();
        await Promise.all(keys.map((k) => window.caches.delete(k)));
      }
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch { /* best effort — reload regardless */ }
    window.location.reload();
  }, []);

  return (
    <div className="space-y-7">
      <section>
        <div className="flex items-center gap-1.5 px-1 pb-2">
          <Bug className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden="true" />
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Environment</h2>
        </div>
        <div className={INSET_LIST} data-testid="dev-environment">
          {Object.entries(info).map(([k, v]) => (
            <InfoRow key={k} label={k} value={v} />
          ))}
          <InfoRow label="serviceWorker" value={swScope === undefined ? "checking…" : swScope || "none"} />
        </div>
      </section>

      <section>
        <h2 className={GROUP_LABEL}>Backend health</h2>
        <button
          onClick={runProbe}
          disabled={probing}
          className={`${INSET_ROW} ${probe ? "" : "rounded-2xl bg-[var(--bg-secondary)]"}`}
        >
          <span className="flex items-center gap-2">
            <Activity className={`w-4 h-4 ${probing ? "animate-pulse" : ""}`} />
            {probing ? "Checking…" : "Ping backend"}
          </span>
          {probe && (
            <span
              className={`font-mono text-[11px] ${
                probe.ok ? "text-[var(--accent)]" : "text-[var(--danger)]"
              }`}
            >
              {probe.ok ? `HTTP ${probe.status}` : probe.status ? `HTTP ${probe.status}` : "FAILED"}
              {" · "}{probe.ms}ms
            </span>
          )}
        </button>
      </section>

      <section>
        <div className="flex items-center justify-between px-1 pb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Recent log ({entries.length})
          </h2>
          {entries.length > 0 && (
            <button
              onClick={() => { clearDebugEntries(); setEntries([]); }}
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              Clear
            </button>
          )}
        </div>
        {newestFirst.length === 0 ? (
          <p className="px-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            Nothing captured yet. Errors, failed network calls and warnings will appear here.
          </p>
        ) : (
          <div className={INSET_LIST} data-testid="dev-log">
            {newestFirst.map((e, i) => (
              <div key={`${e.at}-${i}`} className="px-4 py-2.5">
                <div className="flex items-baseline gap-2">
                  <span
                    className={`text-[10px] font-semibold uppercase shrink-0 ${
                      e.level === "error" ? "text-[var(--danger)]" : "text-amber-500"
                    }`}
                  >
                    {e.level}
                  </span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">{e.at}</span>
                </div>
                <div className="text-xs text-[var(--text-secondary)] break-words mt-0.5">{e.message}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className={GROUP_LABEL}>Actions</h2>
        <div className={INSET_LIST}>
          <button onClick={copyAll} className={ACTION_BTN}>
            <ClipboardCopy className="w-4 h-4 text-[var(--text-muted)]" />
            Copy diagnostics
          </button>
          <button onClick={clearCacheAndReload} className={ACTION_BTN}>
            <RefreshCw className="w-4 h-4 text-[var(--text-muted)]" />
            Clear cache &amp; reload
          </button>
          <button onClick={onDisable} className={`${ACTION_BTN} text-[var(--danger)]`}>
            <Trash2 className="w-4 h-4" />
            Turn off debug mode
          </button>
        </div>
        <p className="px-1 pt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Also open the app with <span className="font-mono">?debug=0</span> to turn this off.
        </p>
      </section>
    </div>
  );
}
