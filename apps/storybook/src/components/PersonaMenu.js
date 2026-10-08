import { useEffect, useRef, useState } from "react";
import { UserRound, Plus, RefreshCw, Pencil, Check, X, Trash2 } from "lucide-react";
import { API, api } from "../lib/api";
import { canAutofocus } from "../lib/utils";

/**
 * PersonaMenu — dev-only quick-swap dropdown for guest personas.
 *
 * Why this exists: when the LLM-driven goal/milestone creation runs
 * end-to-end, every test account accumulates state. Each persona
 * (Devansh-the-runner, Devansh-the-founder, …) is essentially an
 * empty hermetic DB identity that lets you reload with a different
 * starting state without disconnecting the OAuth host.
 *
 * Bug fix baked into this rewrite: previously the "new guest"
 * action called /api/auth/guest (which sets the `guest_token` cookie)
 * BUT the global auth router checks `session_token` first, so the
 * existing session_token for the dev-user kept resolving and the
 * user reported getting the founder account instead. We now route
 * new-guest creation through /api/auth/dev-login with a fresh uuid,
 * which writes a `session_token` cookie like every other persona
 * and therefore wins the precedence race consistently.
 *
 * Friendly-name flow: when the user clicks "new guest" we pop an
 * inline modal asking for a display name. The default is "Guest N"
 * where N is the persisted-persona count + 1 (predictable, easy to
 * spot). Anyone using the env-flag bypass appreciates not having to
 * type "user_guest_abcdef123456" in the dropdown to find their
 * identity again.
 *
 * Rename: each persona row has an inline pencil that flips into a
 * textarea + check/cancel. Rename issues a POST to /api/auth/dev-login
 * with `user_id=<existing>&name=<new>` — which upserts the user row
 * server-side, so the rename survives across reloads.
 */
export default function PersonaMenu({ currentName, currentUserId, initialOpen = false }) {
  const [open, setOpen] = useState(initialOpen);
  const [personas, setPersonas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [renameId, setRenameId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [newPersonaOpen, setNewPersonaOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBusy, setNewBusy] = useState(false);
  const [newError, setNewError] = useState("");
  const rootRef = useRef(null);

  const fetchPersonas = () => {
    setLoading(true)
    setError(null)
    fetch(`${API}/auth/personas`, { credentials: "include" })
      .then(async (r) => {
        if (r.status === 404) { setPersonas([]); return }
        if (!r.ok) throw new Error(`${r.status}`)
        // `r.json()` throws on non-JSON (HTML 404 page, dev-server proxy
        // 502, etc). The other fetch sites in this file already use
        // `.catch(() => ({}))` for exactly this reason — keep it
        // consistent so a missing endpoint doesn't surface as a
        // "Unexpected token '<'" parse error to the user.
        const data = await r.json().catch(() => ({}))
        setPersonas(data.personas || [])
      })
      .catch((e) => setError(e?.message || "Couldn't load personas"))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!open) return;
    fetchPersonas()
  }, [open])

  useEffect(() => {
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false)
        setRenameId(null)
        setNewPersonaOpen(false)
      }
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [])

  const switchTo = async (userId, name) => {
    const params = new URLSearchParams({ user_id: userId, name })
    const res = await fetch(`${API}/auth/dev-login?${params.toString()}`, {
      method: "POST",
      credentials: "include",
    })
    if (!res.ok) return
    window.location.reload()
  }

  const deletePersona = async (userId) => {
    try {
      const res = await fetch(`${API}/auth/personas/${encodeURIComponent(userId)}`, {
        method: "DELETE",
        credentials: "include",
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.detail || `${res.status}`)
      }
      setPersonas((prev) => prev.filter((p) => p.user_id !== userId))
    } catch (e) {
      setError(e?.message || "Couldn't delete persona")
    }
  }

  const createPersona = async (rawName) => {
    setNewBusy(true)
    setNewError("")
    try {
      // Fresh uuid — distinct from any existing persona. Server's
      // dev-login route uses this for the user_id column.
      const newId = `user_guest_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
      const defaultName = `Guest ${personas.length + 1}`
      const finalName = (rawName || "").trim() || defaultName
      const params = new URLSearchParams({ user_id: newId, name: finalName })
      const res = await fetch(`${API}/auth/dev-login?${params.toString()}`, {
        method: "POST",
        credentials: "include",
      })
      if (!res.ok) throw new Error("dev-login failed")
      // The dev-login route sets session_token + writes the user row.
      // Refresh so we land on the new identity and the persona list.
      window.location.reload()
    } catch (e) {
      setNewError(e?.message || "Could not create persona")
      setNewBusy(false)
    }
  }

  const submitRename = async (userId) => {
    const trimmed = renameValue.trim()
    if (!trimmed) { setRenameId(null); return }
    setRenameBusy(true)
    try {
      const params = new URLSearchParams({ user_id: userId, name: trimmed })
      const res = await fetch(`${API}/auth/dev-login?${params.toString()}`, {
        method: "POST",
        credentials: "include",
      })
      if (!res.ok) throw new Error("rename failed")
      // Local-state update keeps the dropdown snappy; no need to reload
      // the page just for a name change.
      setPersonas((prev) =>
        prev.map((p) => (p.user_id === userId ? { ...p, name: trimmed } : p)),
      )
      setRenameId(null)
      setRenameValue("")
    } catch (e) {
      setError(e?.message || "Could not rename")
    } finally {
      setRenameBusy(false)
    }
  }

  const chipLabel = currentName ? currentName.split(" ")[0] || "Guest" : "Guest"

  return (
    <div ref={rootRef} className="relative">
      <button
        data-testid="persona-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        title="Switch persona (dev-only)"
        className="min-w-11 h-11 sm:h-9 px-2 sm:px-3 flex items-center gap-1.5 border border-[var(--border)] hover:border-[var(--border-accent)] text-[var(--text-secondary)] font-mono text-[11px] uppercase tracking-wider transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        <UserRound className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">{chipLabel}</span>
      </button>
      {open && (
        <div
          data-testid="persona-menu"
          className="absolute right-0 mt-1 w-80 bg-[var(--bg-secondary)] border border-[var(--border)] shadow-2xl z-50"
        >
          <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">
                Personas · dev only
              </div>
              <div className="text-xs text-[var(--text-secondary)] mt-0.5">
                Switch identity to test different starts.
              </div>
            </div>
            <button
              type="button"
              onClick={fetchPersonas}
              title="Refresh"
              className="min-h-11 min-w-11 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              data-testid="persona-menu-refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          {loading && (
            <div className="px-3 py-3 text-xs text-[var(--text-muted)]">loading…</div>
          )}
          {error && !loading && (
            <div className="px-3 py-3 text-xs text-[var(--danger)]">{error}</div>
          )}

          {!loading && !error && (
            <ul className="max-h-72 overflow-y-auto">
              {personas.length === 0 ? (
                <li className="px-3 py-3 text-xs text-[var(--text-muted)]">
                  No saved personas yet. Click "Continue as new person below" below to create the first.
                </li>
              ) : (
                personas.map((p) => {
                  const isCurrent = currentUserId && p.user_id === currentUserId
                  const isRenaming = renameId === p.user_id
                  return (
                    <li
                      key={p.user_id}
                      data-testid={`persona-item-${p.user_id}`}
                      className="border-b border-[var(--border)] last:border-0"
                    >
                      <div className="flex items-start gap-2 px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => switchTo(p.user_id, p.name || "Guest")}
                          disabled={isCurrent}
                          className="min-h-11 flex-1 text-left min-w-0 hover:bg-[var(--bg-tertiary)] -mx-1 px-1 py-0.5 rounded transition-colors disabled:cursor-default disabled:hover:bg-transparent"
                        >
                          {isRenaming ? (
                            <input
                              autoFocus={canAutofocus()}
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") submitRename(p.user_id)
                                if (e.key === "Escape") setRenameId(null)
                              }}
                              className="w-full bg-[var(--bg-primary)] border border-[var(--border-accent)] rounded px-1.5 py-1 text-sm"
                              data-testid={`persona-rename-input-${p.user_id}`}
                            />
                          ) : (
                            <>
                              <div className="text-sm text-[var(--text-primary)] truncate">
                                {p.name || "Guest"}
                                {isCurrent && (
                                  <span className="ml-1.5 font-mono text-[9px] uppercase tracking-widest text-[var(--accent)]">
                                    current
                                  </span>
                                )}
                              </div>
                              <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-muted)] mt-0.5 truncate">
                                {p.user_id}
                                <span className="mx-1.5">·</span>
                                {new Date(p.created_at).toLocaleDateString()}
                              </div>
                            </>
                          )}
                        </button>
                        {isRenaming ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => submitRename(p.user_id)}
                              disabled={renameBusy || !renameValue.trim()}
                              className="min-h-11 min-w-11 inline-flex items-center justify-center text-[var(--success)] hover:opacity-80 disabled:opacity-40"
                              title="Save"
                              data-testid={`persona-rename-save-${p.user_id}`}
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => { setRenameId(null); setRenameValue("") }}
                              className="min-h-11 min-w-11 inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => { setRenameId(p.user_id); setRenameValue(p.name || "") }}
                              className="min-h-11 min-w-11 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)]"
                              title="Rename persona"
                              data-testid={`persona-rename-trigger-${p.user_id}`}
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            {!p.persona_key && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (window.confirm(`Delete persona "${p.name || "Guest"}"? Their goals, memories, and history will be removed.`)) {
                                    deletePersona(p.user_id)
                                  }
                                }}
                                className="min-h-11 min-w-11 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--danger)]"
                                title="Delete persona"
                                data-testid={`persona-delete-trigger-${p.user_id}`}
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })
              )}
            </ul>
          )}

          <div className="border-t border-[var(--border)]">
            <button
              type="button"
              data-testid="persona-new-guest"
              onClick={() => setNewPersonaOpen(true)}
              className="min-h-11 w-full flex items-center gap-2 px-3 py-3 text-xs text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Continue as new person (fresh identity)
            </button>
          </div>

          {newPersonaOpen && (
            <div
              data-testid="persona-new-modal"
              className="absolute inset-x-0 top-0 bg-[var(--bg-secondary)] border border-[var(--border-accent)] p-3 shadow-2xl z-10 rounded"
            >
              <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">
                New persona
              </div>
              <div className="text-xs text-[var(--text-secondary)] mt-1">
                Give this identity a display name so it's easy to pick later. Leave blank for "Guest N".
              </div>
              <input
                autoFocus={canAutofocus()}
                data-testid="persona-new-name-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createPersona(newName)
                  if (e.key === "Escape") setNewPersonaOpen(false)
                }}
                placeholder={`Guest ${personas.length + 1}`}
                className="mt-2 w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2.5 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-accent)]"
              />
              {newError && (
                <div className="mt-1.5 text-[11px] text-[var(--danger)]">{newError}</div>
              )}
              <div className="mt-2.5 flex items-center gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => { setNewPersonaOpen(false); setNewError("") }}
                  className="min-h-11 text-[11px] px-2.5 py-1.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                  data-testid="persona-new-cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => createPersona(newName)}
                  disabled={newBusy}
                  className="min-h-11 text-[11px] px-2.5 py-1.5 rounded bg-[var(--accent)] text-[var(--bg-primary)] font-medium hover:opacity-90 disabled:opacity-50"
                  data-testid="persona-new-save"
                >
                  {newBusy ? "Creating…" : "Create & switch"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
