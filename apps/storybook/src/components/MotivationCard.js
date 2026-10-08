import { useEffect, useState, useRef } from "react";
import { Sparkles, ExternalLink, Loader2, BookOpen, Headphones, Video, FileText } from "lucide-react";
import { api } from "../lib/api";
import { localDateKey } from "../lib/utils";

/**
 * MotivationCard — read-only. Surfaces 1-3 curated items fetched from
 * /api/motivation/recommend. There is no refresh / retry / dismiss
 * control: the backend refreshes its own cache in the background (on a
 * miss, and when a cached row has expired within its stale window), so
 * a later visit serves the refreshed picks.
 *
 * We poll silently while a background job is in flight so a fresh
 * `cache: 'hit'` can appear in-session; if nothing lands before the
 * cap, the card just shows a friendly "nothing for you" line.
 *
 * UX rules:
 *   - Skips itself silently when nothing interesting is happening
 *     (no overdue, no active goals) — never nags the user.
 */
const POLL_INTERVAL_MS = 5_000
// Cap on how long we keep polling for a fresh LLM-curated row. The
// server's pipeline takes ~20-30s on a healthy day; we leave headroom
// and stop after this so a broken LLM / missing Tavily key doesn't
// leave the frontend polling the route every 5s forever.
const POLL_MAX_DURATION_MS = 60_000

export default function MotivationCard({ state }) {
  const [items, setItems] = useState([])
  // True while a background refresh is in flight (server told us the
  // cache is `miss`, or a stale row is being revalidated). Drives the
  // "searching" line; flips false on a `hit`, on error, or at the cap.
  const [inFlight, setInFlight] = useState(true)
  const pollRef = useRef(null)

  const overdueCount = (state?.milestones || []).filter(
    (m) =>
      (m.status || "open") !== "done" &&
      m.target_date &&
      m.target_date < localDateKey(),
  ).length
  const activeGoals = (state?.goals || []).filter((g) => g.status === "active").length

  const shouldShow = overdueCount > 0 || activeGoals > 0

  const stopPolling = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => {
    if (!shouldShow) return
    let cancelled = false

    const load = () =>
      api
        .motivation()
        .then((d) => {
          if (cancelled) return
          setItems(d.items || [])
          if (d.cache === "hit") {
            // Fresh LLM-curated row landed — swap in and stop polling.
            setInFlight(false)
            stopPolling()
          }
          // Still 'miss' / 'stale' → keep polling (until the cap).
        })
        .catch(() => {
          if (cancelled) return
          // Non-fatal — show the friendly empty line instead of an error.
          setInFlight(false)
          stopPolling()
        })

    setInFlight(true)
    load()
    const pollStartedAt = Date.now()
    pollRef.current = setInterval(() => {
      if (Date.now() - pollStartedAt > POLL_MAX_DURATION_MS) {
        setInFlight(false)
        stopPolling()
        return
      }
      load()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldShow])

  if (!shouldShow) return null

  return (
    <div
      data-testid="motivation-card"
      className="border border-[var(--border)] bg-gradient-to-br from-[color-mix(in_srgb,var(--accent)_10%,transparent)] via-[color-mix(in_srgb,var(--accent)_5%,transparent)] to-transparent rounded-xl overflow-hidden"
    >
      <div className="px-4 sm:px-5 py-3.5 flex items-center gap-2 border-b border-[var(--border)]">
        <Sparkles className="w-4 h-4 text-[var(--accent)]" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-[var(--text-primary)]">
            Articles & videos curated for you
          </div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
            Picked from what you're working on
          </div>
        </div>
      </div>

      <ul className="px-4 sm:px-5 py-3 space-y-2.5">
        {items.length === 0 && (
          <li
            className="flex items-center gap-2 text-xs text-[var(--text-muted)] py-2"
            data-testid={inFlight ? "motivation-searching" : "motivation-empty"}
          >
            {inFlight ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Searching the web for what fits right now…</span>
              </>
            ) : (
              <span>Nothing for you right now — you're doing great.</span>
            )}
          </li>
        )}
        {items.map((it) => (
          <li
            key={it.id}
            data-testid={`motivation-item-${it.id}`}
            className="flex items-start gap-3 p-2.5 rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-primary)_40%,transparent)]"
          >
            <KindIcon kind={it.kind} />
            <div className="flex-1 min-w-0">
              <a
                href={it.url}
                target="_blank"
                rel="noreferrer"
                className="min-h-11 text-sm font-medium text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors inline-flex items-center gap-1 group"
              >
                {it.title}
                <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              </a>
              <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-muted)] mt-0.5">
                {it.author} · {it.kind} · {it.duration}
              </div>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed mt-1.5">
                {it.frame}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function KindIcon({ kind }) {
  const map = {
    book: BookOpen,
    video: Video,
    article: FileText,
    talk: Headphones,
  }
  const Icon = map[kind] || Sparkles
  return (
    <div className="h-11 w-11 shrink-0 rounded-md bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] flex items-center justify-center">
      <Icon className="w-4 h-4 text-[var(--accent)]" />
    </div>
  )
}
