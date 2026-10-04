import { useEffect, useState, useCallback, useRef } from "react";
import { Image as ImageIcon, Link2, Plus, Trash2, X, Loader2, Camera, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Download } from "lucide-react";
import { api, API } from "../lib/api";
import { usePersistentState } from "../hooks/useDraftPersistence";
import AutoTextarea from "./AutoTextarea";

/**
 * Memories — user-pinned photos and Instagram embeds.
 *
 * Two ways to add:
 *   1. Upload a photo: pick a file from disk. The photo goes
 *      through the existing /api/sources/upload pipeline (so the
 *      underlying file lands in the same place all sources do)
 *      and then /api/memories pins that source row as a memory.
 *   2. Paste an Instagram URL: we parse the shortcode, render
 *      the canonical /embed iframe. No scraping of instagram.com
 *      itself — just the public embed endpoint.
 *
 * Display:
 *   - Grid of cards (responsive: 2 cols on mobile, 3 on sm, 4 on lg).
 *   - Photo cards show the image inline (lazy-loaded via the
 *     existing /api/sources/[id]/download flow).
 *   - Instagram cards render the public embed iframe so the user
 *     can scroll/play without leaving the app.
 *   - Each card shows the caption (or a default), date, and the
 *     linked goal title when present. Trash icon deletes (DELETE
 *     /api/memories/[id]).
 *
 * Notes:
 *   - We deliberately do NOT render goal-edit affordances inside a
 *     memory card; goals are managed on the Goals tab. Memories
 *     are a flat timeline.
 *   - The "Add" button opens an inline form with two tabs (Photo
 *     | Instagram). Switching the tab resets the inputs so the
 *     user doesn't accidentally submit the wrong kind.
 */
export default function Memories({ state, onChange }) {
  const [memories, setMemories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = usePersistentState("memory:new:kind", "photo")
  const [file, setFile] = useState(null)
  const [url, setUrl] = usePersistentState("memory:new:url", "")
  const [caption, setCaption] = usePersistentState("memory:new:caption", "")
  const [goalId, setGoalId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")
  // Iteration 5 (Ask 6) — lightbox state. `null` = closed; number = open index in `memories`.
  const [lightboxIndex, setLightboxIndex] = useState(null)
  const goPrev = useCallback(() => {
    setLightboxIndex((i) => (i == null ? null : (i - 1 + memories.length) % memories.length))
  }, [memories.length])
  const goNext = useCallback(() => {
    setLightboxIndex((i) => (i == null ? null : (i + 1) % memories.length))
  }, [memories.length])

  const refresh = () => {
    setLoading(true)
    setError(null)
    api
      .memories()
      .then((d) => setMemories(d.memories || []))
      .catch((err) => {
        console.error("Failed to load memories:", err)
        setError(err)
      })
      .finally(() => setLoading(false))
  }

  useEffect(refresh, [])

  const submitPhoto = async () => {
    if (!file) return
    setSubmitting(true)
    setSubmitError("")
    try {
      // Step 1: upload the file through the existing sources pipeline
      // so the bytes land in the same storage bucket as everything
      // else, and we get a `source_id` back.
      const source = await api.uploadSource(file, goalId || "")
      // Step 2: pin that source as a memory.
      await api.createMemory({
        kind: "photo",
        source_id: source.id,
        caption,
        goal_id: goalId || "",
      })
      setFile(null)
      setCaption("")
      setGoalId("")
      setAdding(false)
      refresh()
      onChange?.()
    } catch (e) {
      setSubmitError(e?.message || "Could not save photo memory")
    } finally {
      setSubmitting(false)
    }
  }

  const submitInstagram = async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    // Light client-side shape check so the user gets feedback before
    // a round-trip. Server is the source of truth on validity.
    if (!/^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?/.test(trimmed)) {
      setSubmitError("That doesn't look like an Instagram post URL — paste a link like instagram.com/p/...")
      return
    }
    setSubmitting(true)
    setSubmitError("")
    try {
      await api.createMemory({
        kind: "instagram",
        external_url: trimmed,
        caption,
        goal_id: goalId || "",
      })
      setUrl("")
      setCaption("")
      setGoalId("")
      setAdding(false)
      refresh()
      onChange?.()
    } catch (e) {
      setSubmitError(e?.message || "Could not save Instagram memory")
    } finally {
      setSubmitting(false)
    }
  }

  const deleteMemory = async (id) => {
    try {
      await api.deleteMemory(id)
      setMemories((prev) => prev.filter((m) => m.id !== id))
      onChange?.()
    } catch {
      /* ignore */
    }
  }

  const goals = (state?.goals || []).filter((g) => g.status !== "dropped")

  return (
    <div data-testid="memories-view" className="px-4 sm:px-6 py-5 sm:py-6 space-y-5 max-w-[820px] mx-auto w-full">
      <div className="flex items-end justify-between gap-3">
        <p className="text-[14px] text-[var(--text-secondary)] max-w-md leading-relaxed">
          Photos and posts that anchor your goals — what's the why, what does it look like?
        </p>
        {!adding && (
          <button
            data-testid="memories-add-button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 px-4 h-11 rounded-full bg-[var(--accent)] text-[var(--bg-primary)] text-sm font-semibold hover:opacity-90 transition-opacity shrink-0"
          >
            <Plus className="w-4 h-4" /> Add memory
          </button>
        )}
      </div>

      {adding && (
        <div
          data-testid="memories-add-form"
          className="border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] rounded-lg p-4 space-y-3"
        >
          <div className="flex items-center gap-1.5">
            <div className="inline-flex rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)] p-0.5">
              <button
                data-testid="memories-kind-photo"
                onClick={() => { setKind("photo"); setSubmitError(""); }}
                className={`px-3 h-11 text-[11px] font-mono uppercase tracking-widest transition-colors flex items-center gap-1 rounded ${
                  kind === "photo"
                    ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--accent)]"
                }`}
              >
                <Camera className="w-3 h-3" /> Photo
              </button>
              <button
                data-testid="memories-kind-instagram"
                onClick={() => { setKind("instagram"); setSubmitError(""); }}
                className={`px-3 h-11 text-[11px] font-mono uppercase tracking-widest transition-colors flex items-center gap-1 rounded ${
                  kind === "instagram"
                    ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--accent)]"
                }`}
              >
                <Link2 className="w-3 h-3" /> Instagram
              </button>
            </div>
          </div>

          {kind === "photo" ? (
            <div>
              <span className="block text-[11px] font-mono uppercase tracking-widest text-[var(--text-muted)] mb-1.5">
                Photo
              </span>
              <div className="flex flex-wrap gap-2">
                <label className="min-h-11 inline-flex items-center gap-2 px-3.5 rounded-lg border border-[var(--border)] text-[13px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-accent)] hover:text-[var(--text-primary)] cursor-pointer transition-colors">
                  <ImageIcon className="w-4 h-4" aria-hidden="true" />
                  Choose file
                  <input
                    data-testid="memories-file-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
                    aria-label="Photo file"
                    hidden
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                  />
                </label>
                <label className="min-h-11 inline-flex items-center gap-2 px-3.5 rounded-lg border border-[var(--border)] text-[13px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-accent)] hover:text-[var(--text-primary)] cursor-pointer transition-colors">
                  <Camera className="w-4 h-4" aria-hidden="true" />
                  Take photo
                  <input
                    data-testid="memories-camera-input"
                    type="file"
                    accept="image/*"
                    capture="environment"
                    aria-label="Take a photo"
                    hidden
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                  />
                </label>
              </div>
              {file && (
                <div className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                  {file.name} · {Math.round(file.size / 1024)} KB
                </div>
              )}
            </div>
          ) : (
            <label className="block">
              <span className="block text-[11px] font-mono uppercase tracking-widest text-[var(--text-muted)] mb-1">
                Instagram URL
              </span>
              <input
                data-testid="memories-url-input"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.instagram.com/p/{shortcode}/"
                aria-label="Instagram URL"
                className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-accent)]"
              />
            </label>
          )}

          <label className="block">
            <span className="block text-[11px] font-mono uppercase tracking-widest text-[var(--text-muted)] mb-1">
              Caption <span className="text-[color-mix(in_srgb,var(--text-muted)_70%,transparent)] normal-case tracking-normal">(optional)</span>
            </span>
            <AutoTextarea
              data-testid="memories-caption-input"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Why this memory matters"
              aria-label="Caption"
              maxLength={200}
              minRows={2}
              maxRows={5}
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm leading-[22px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-accent)]"
            />
          </label>

          <label className="block">
            <span className="block text-[11px] font-mono uppercase tracking-widest text-[var(--text-muted)] mb-1">
              Linked goal <span className="text-[color-mix(in_srgb,var(--text-muted)_70%,transparent)] normal-case tracking-normal">(optional)</span>
            </span>
            <select
              data-testid="memories-goal-select"
              value={goalId}
              onChange={(e) => setGoalId(e.target.value)}
              aria-label="Linked goal"
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-3 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-accent)]"
            >
              <option value="">No goal linkage</option>
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </label>

          {submitError && (
            <div className="text-xs text-[var(--danger)]">{submitError}</div>
          )}

          <div className="flex items-center gap-2 justify-end pt-1">
            <button
              type="button"
              data-testid="memories-cancel"
              onClick={() => {
                setAdding(false)
                setFile(null)
                setUrl("")
                setCaption("")
                setGoalId("")
                setSubmitError("")
              }}
              className="min-h-11 text-xs px-3 py-1.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="memories-save"
              onClick={kind === "photo" ? submitPhoto : submitInstagram}
              disabled={submitting || (kind === "photo" ? !file : !url.trim())}
              className="flex items-center gap-1.5 min-h-11 text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--bg-primary)] font-medium hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Plus className="w-3 h-3" />
              )}
              Save memory
            </button>
          </div>
        </div>
      )}

      {loading && memories.length === 0 && (
        <div
          data-testid="memories-skeleton"
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"
          aria-busy="true"
          aria-live="polite"
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] rounded-lg overflow-hidden space-y-2 p-2.5"
            >
              <div className="aspect-square w-full gc-skeleton rounded" />
              <div className="space-y-1.5 pt-1">
                <div className="h-3 w-4/5 gc-skeleton" />
                <div className="h-2.5 w-1/2 gc-skeleton" />
              </div>
            </div>
          ))}
        </div>
      )}

      {loading && memories.length > 0 && (
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-[var(--text-muted)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          refreshing…
        </div>
      )}

      {!loading && error && (
        <div className="border border-[var(--border)] rounded-lg p-6 text-center space-y-3 bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)]" data-testid="memories-error">
          <p className="text-xs text-[var(--text-secondary)]">Couldn't load memories</p>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1.5 min-h-11 text-xs px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--bg-primary)] font-medium hover:opacity-90 transition-opacity"
          >
            <RefreshCw className="w-3 h-3" />
            Couldn't load — retry
          </button>
        </div>
      )}

      {!loading && !error && memories.length === 0 && !adding && (
        <div className="rounded-2xl bg-[var(--bg-secondary)] p-8 sm:p-12 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center mb-3">
            <ImageIcon className="w-6 h-6 text-[var(--text-muted)]" />
          </div>
          <p className="text-[15px] text-[var(--text-secondary)] leading-relaxed max-w-sm mx-auto">
            Pin the things that make goals real — a photo of where you want to be, the post
            that got you started.
          </p>
        </div>
      )}

      {memories.length > 0 && (
        <div
          data-testid="memories-grid"
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"
        >
          {memories.map((m, i) => (
            <MemoryCard
              key={m.id}
              memory={m}
              isPhoto={m.kind === "photo" && !!m.source_id}
              onOpen={() => setLightboxIndex(i)}
              onDelete={() => deleteMemory(m.id)}
            />
          ))}
        </div>
      )}

      <MemoryLightbox
        memories={memories}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onPrev={goPrev}
        onNext={goNext}
        onDelete={async (id) => { await deleteMemory(id); goPrev(); }}
      />
    </div>
  )
}

function MemoryCard({ memory, isPhoto, onOpen, onDelete }) {
  const downloadUrl = isPhoto ? `${API}/sources/${memory.source_id}/download` : null;
  return (
    <div
      data-testid={`memory-card-${memory.id}`}
      className="border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] rounded-lg overflow-hidden group"
    >
      <div className="aspect-square bg-[var(--bg-tertiary)] relative overflow-hidden">
        {memory.kind === "photo" && memory.source_id ? (
          <button
            type="button"
            data-testid={`memory-photo-${memory.id}`}
            onClick={onOpen}
            aria-label={memory.caption ? `Open photo: ${memory.caption}` : "Open photo"}
            className="block w-full h-full p-0 m-0 border-0 cursor-zoom-in focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            <img
              src={`${API}/sources/${memory.source_id}/download`}
              alt={memory.caption || "Memory"}
              className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]"
              loading="lazy"
            />
          </button>
        ) : memory.kind === "instagram" && memory.instagram_shortcode ? (
          <InstagramEmbed shortcode={memory.instagram_shortcode} caption={memory.caption} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[var(--text-muted)]">
            <ImageIcon className="w-8 h-8" />
          </div>
        )}
        {/* Overlay actions. Download is always visible on hover for photos
            (and permanently in the card footer below) so the user can
            keep the original file; delete is in the lightbox for photos
            so the trash never covers the picture. */}
        <div className="absolute top-1 right-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {downloadUrl && (
            <a
              href={downloadUrl}
              download
              data-testid={`memory-download-${memory.id}`}
              onClick={(e) => e.stopPropagation()}
              aria-label="Download photo"
              title="Download photo"
              className="h-11 w-11 flex items-center justify-center rounded bg-black/60 text-white hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          )}
          {!isPhoto && memory.kind === "instagram" && memory.external_url && (
            <a
              href={memory.external_url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`memory-open-instagram-overlay-${memory.id}`}
              onClick={(e) => e.stopPropagation()}
              aria-label="Open on Instagram"
              title="Open on Instagram"
              className="h-11 w-11 flex items-center justify-center rounded bg-black/60 text-white hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          )}
          {!isPhoto && (
            <button
              type="button"
              data-testid={`memory-delete-${memory.id}`}
              onClick={onDelete}
              aria-label="Delete memory"
              className="h-11 w-11 flex items-center justify-center rounded bg-black/60 text-white hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="p-2.5 space-y-1">
        {memory.caption && (
          <div className="text-xs text-[var(--text-primary)] leading-snug line-clamp-2">
            {memory.caption}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">
          <span>
            {new Date(memory.created_at).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
          </span>
          {memory.goal_title && (
            <>
              <span className="opacity-50">·</span>
              <span
                className="min-w-0 flex-1 truncate hover:text-[var(--accent)] transition-colors"
                title={`Linked to ${memory.goal_title}`}
              >
                {memory.goal_title}
              </span>
            </>
          )}
          {downloadUrl && (
            <>
              <span className="opacity-50">·</span>
              {/* Always-visible download in the footer — the hover
                  overlay alone is undiscoverable on touch devices. */}
              <a
                href={downloadUrl}
                download
                data-testid={`memory-download-link-${memory.id}`}
                className="min-h-11 min-w-11 inline-flex items-center justify-center gap-1 hover:text-[var(--accent)] transition-colors"
                title="Download the original file"
                aria-label="Download the original file"
              >
                <Download className="w-3 h-3" aria-hidden="true" />
                <span className="hidden sm:inline">download</span>
              </a>
            </>
          )}
          {memory.kind === "instagram" && memory.external_url && (
            <>
              <span className="opacity-50">·</span>
              {/* Reliable escape hatch: some posts (e.g. long share
                  links / private accounts) can't be rendered by the
                  embed, so let the user open the original URL. */}
              <a
                href={memory.external_url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`memory-open-instagram-${memory.id}`}
                className="min-h-11 min-w-11 inline-flex items-center justify-center gap-1 hover:text-[var(--accent)] transition-colors"
                title="Open this post on Instagram"
                aria-label="Open this post on Instagram"
              >
                <ExternalLink className="w-3 h-3" aria-hidden="true" />
                <span className="hidden sm:inline">instagram</span>
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function InstagramEmbed({ shortcode, caption }) {
  const src = `https://www.instagram.com/p/${shortcode}/embed`
  return (
    <iframe
      title={caption || `Instagram post ${shortcode}`}
      src={src}
      className="w-full h-full bg-[var(--bg-primary)]"
      allowtransparency="true"
      scrolling="no"
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  )
}

/**
 * MemoryLightbox — fullscreen photo viewer (Iteration 5 Ask 6).
 *
 * Open when `index` is a number; null = closed.
 *
 * Interaction:
 *   - Desktop: left/right chevron buttons.
 *   - Mobile: swipe horizontally (touchstart records startX, touchend
 *     compares to endX with a 50px threshold so taps and small
 *     motions don't fire).
 *   - All clients: ESC closes, click on the backdrop (outside the
 *     photo + outside the chevrons) closes.
 *
 * Delete affordance moves here from the card's group-hover overlay so
 * the lightbox chrome stays minimal and the trash button isn't blocked
 * by the photo itself.
 */
function MemoryLightbox({ memories, index, onClose, onPrev, onNext, onDelete }) {
  const touchStartXRef = useRef(null);

  useEffect(() => {
    if (index == null) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
      else if (e.key === "ArrowLeft") onPrev?.();
      else if (e.key === "ArrowRight") onNext?.();
    };
    document.addEventListener("keydown", onKey);
    // Lock background scroll while overlay is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [index, onClose, onPrev, onNext]);

  if (index == null || !memories || memories.length === 0) return null;
  const mem = memories[index];
  if (!mem) return null;

  const isPhoto = mem.kind === "photo" && !!mem.source_id;
  const imgSrc = isPhoto ? `${API}/sources/${mem.source_id}/download` : null;

  const handleTouchStart = (e) => {
    const t = e.touches?.[0];
    if (t) touchStartXRef.current = t.clientX;
  };
  const handleTouchEnd = (e) => {
    const startX = touchStartXRef.current;
    const t = e.changedTouches?.[0];
    touchStartXRef.current = null;
    if (startX == null || !t) return;
    const dx = t.clientX - startX;
    if (Math.abs(dx) < 50) return;
    if (dx > 0) onPrev?.();
    else onNext?.();
  };

  const hasMany = memories.length > 1;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget) onClose?.();
  };

  return (
    <div
      data-testid="memory-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={mem.caption || "Memory photo"}
      onClick={handleBackdrop}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
    >
      {/* Header chrome — close + delete + caption. Stop propagation
          so clicks here don't bubble to the backdrop close handler. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute top-3 left-3 right-3 flex items-start gap-3"
      >
        <div className="flex-1 min-w-0">
          {mem.caption && (
            <div className="text-sm text-white/90 line-clamp-2">{mem.caption}</div>
          )}
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-white/60">
            <span>
              {new Date(mem.created_at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            {hasMany && (
              <span>
                {index + 1} / {memories.length}
              </span>
            )}
          </div>
        </div>
        <a
          href={imgSrc || "#"}
          download
          data-testid="memory-lightbox-download"
          onClick={(e) => { if (!imgSrc) e.preventDefault(); }}
          aria-label="Download this photo"
          title="Download the original file"
          className={`h-11 w-11 flex items-center justify-center rounded bg-black/60 text-white/80 hover:text-white hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
            imgSrc ? "" : "opacity-40 pointer-events-none"
          }`}
        >
          <Download className="w-4 h-4" aria-hidden="true" />
        </a>
        <button
          type="button"
          data-testid="memory-lightbox-delete"
          onClick={() => onDelete?.(mem.id)}
          aria-label="Delete this memory"
          className="h-11 w-11 flex items-center justify-center rounded bg-black/60 text-white/80 hover:text-white hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <Trash2 className="w-4 h-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="memory-lightbox-close"
          onClick={onClose}
          aria-label="Close"
          className="h-11 w-11 flex items-center justify-center rounded bg-black/60 text-white/80 hover:text-white hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      {/* Prev / next chevrons — desktop only; mobile uses swipe.
          Hidden when only one memory. */}
      {hasMany && (
        <>
          <button
            type="button"
            data-testid="memory-lightbox-prev"
            onClick={(e) => { e.stopPropagation(); onPrev?.(); }}
            aria-label="Previous photo"
            className="hidden sm:flex absolute left-3 top-1/2 -translate-y-1/2 h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <ChevronLeft className="w-6 h-6" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="memory-lightbox-next"
            onClick={(e) => { e.stopPropagation(); onNext?.(); }}
            aria-label="Next photo"
            className="hidden sm:flex absolute right-3 top-1/2 -translate-y-1/2 h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <ChevronRight className="w-6 h-6" aria-hidden="true" />
          </button>
        </>
      )}

      {/* Photo. max-h keeps the image inside the viewport so the
          chrome (caption / counters / close) stays accessible. */}
      {isPhoto && imgSrc && (
        <img
          src={imgSrc}
          alt={mem.caption || "Memory"}
          onClick={(e) => e.stopPropagation()}
          className="relative max-h-[80vh] max-w-[92vw] object-contain rounded shadow-2xl"
        />
      )}
    </div>
  );
}
