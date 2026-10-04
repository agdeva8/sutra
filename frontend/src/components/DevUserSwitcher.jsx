import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, RefreshCw, UserRound } from "lucide-react";
import { API } from "../lib/api";

/**
 * DevUserSwitcher — the "Developer" option that mirrors the localhost
 * persona quick-swap: list every existing persona, switch into one, or
 * continue as a brand-new temp/guest identity (and thereby switch to it).
 *
 * Reuses the existing dev routes verbatim — `/api/auth/personas` (list) and
 * `/api/auth/dev-login` (create/switch). No new backend: these are the same
 * endpoints PersonaMenu drives from the header. This surface just makes the
 * switch a first-class Settings action for a developer account.
 *
 * `onSwitched` lets the caller refresh identity in place; we reload so the
 * whole app re-resolves auth/session exactly like a persona switch.
 */
const INSET_LIST = "rounded-2xl bg-[var(--bg-secondary)] overflow-hidden divide-y divide-[var(--border)]";
const INSET_ROW =
  "w-full flex items-center justify-between gap-3 px-4 py-3 text-left text-sm " +
  "text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60";
const ACTION_BTN =
  "w-full flex items-center gap-2.5 px-4 py-3.5 text-left text-sm font-medium " +
  "text-[var(--accent)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-60";

export default function DevUserSwitcher({ currentUserId }) {
  const [personas, setPersonas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // user_id | "new"

  const load = () => {
    setLoading(true);
    setError(null);
    fetch(`${API}/auth/personas`, { credentials: "include" })
      .then(async (r) => {
        if (r.status === 404) { setPersonas([]); return; }
        if (!r.ok) throw new Error(`${r.status}`);
        const data = await r.json().catch(() => ({}));
        setPersonas(data.personas || []);
      })
      .catch((e) => setError(e?.message || "Couldn't load users"))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  const switchTo = async (userId, name) => {
    setBusy(userId);
    const params = new URLSearchParams({ user_id: userId, name: name || "Guest" });
    try {
      const res = await fetch(`${API}/auth/dev-login?${params}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      // Full reload so auth + all data re-resolve for the new identity.
      window.location.reload();
    } catch (e) {
      toast.error("Couldn't switch user");
      setBusy(null);
    }
  };

  const createAndSwitch = async () => {
    setBusy("new");
    try {
      const id = `user_guest_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const name = `Guest ${personas.length + 1}`;
      const params = new URLSearchParams({ user_id: id, name });
      const res = await fetch(`${API}/auth/dev-login?${params}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      window.location.reload();
    } catch (e) {
      toast.error("Couldn't create user");
      setBusy(null);
    }
  };

  return (
    <div className="space-y-7">
      <section>
        <div className="flex items-center justify-between px-1 pb-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Users
          </h2>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            title="Refresh"
            data-testid="dev-users-refresh"
            className="min-h-8 min-w-8 inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {loading ? (
          <p className="px-1 text-xs text-[var(--text-muted)]">loading…</p>
        ) : error ? (
          <p className="px-1 text-xs text-[var(--danger)]">{error}</p>
        ) : personas.length === 0 ? (
          <p className="px-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            No saved users yet. Continue as a new person below to create the first.
          </p>
        ) : (
          <div className={INSET_LIST} data-testid="dev-users-list">
            {personas.map((p) => {
              const isCurrent = currentUserId && p.user_id === currentUserId;
              return (
                <button
                  key={p.user_id}
                  type="button"
                  onClick={() => switchTo(p.user_id, p.name)}
                  disabled={isCurrent || busy !== null}
                  data-testid={`dev-user-${p.user_id}`}
                  className={INSET_ROW}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <UserRound className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate">
                        {p.name || "Guest"}
                        {isCurrent && (
                          <span className="ml-1.5 font-mono text-[9px] uppercase tracking-widest text-[var(--accent)]">
                            current
                          </span>
                        )}
                      </span>
                      <span className="block font-mono text-[10px] text-[var(--text-muted)] truncate">
                        {p.user_id}
                      </span>
                    </span>
                  </span>
                  {busy === p.user_id && (
                    <span className="text-[11px] text-[var(--text-muted)]">switching…</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className={INSET_LIST}>
          <button
            type="button"
            onClick={createAndSwitch}
            disabled={busy !== null}
            data-testid="dev-user-new"
            className={ACTION_BTN}
          >
            <Plus className="w-4 h-4" />
            {busy === "new" ? "Creating…" : "Continue as a new person (fresh identity)"}
          </button>
        </div>
        <p className="px-1 pt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Creates a hermetic identity and switches into it — the same behaviour as the localhost
          persona switcher. Existing users above are reused, not duplicated.
        </p>
      </section>
    </div>
  );
}
