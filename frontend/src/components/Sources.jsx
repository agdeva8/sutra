import { useEffect, useRef, useState } from "react";
import {
  FileText,
  Link2,
  Trash2,
  ExternalLink,
  Loader2,
  FolderOpen,
  RefreshCw,
  Eye,
  Download,
  X,
  MoreVertical,
  AlertTriangle,
} from "lucide-react";
import { api, API } from "../lib/api";
import LinkPreviewDialog from "./LinkPreviewDialog";

/**
 * Sources — all uploaded files and pasted links the coach reasons over.
 *
 * Sources are reference material attached to goals (or kept general).
 * This tab gives a flat grid view: kind icon, name/title, date, linked
 * goal, and actions (view / download / delete).
 *
 * Kind 'file': download from /api/sources/:id/download
 * Kind 'link': open external_url in a new tab
 * Delete: DELETE /api/sources/:id
 */
export default function Sources({ state, onChange }) {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null); // id of source being deleted
  const [viewingSource, setViewingSource] = useState(null); // Iteration 7 — View dialog
  // Iteration 11 — link sources open the LLM exploration dialog (with their
  // stored excerpt) instead of the raw iframe viewer, so the user can see
  // what the coach read and edit it.
  const [exploringSource, setExploringSource] = useState(null);

  const refresh = () => {
    setLoading(true);
    setError(null);
    api
      .sources()
      .then((d) => setSources(Array.isArray(d) ? d : d?.sources || []))
      .catch((err) => {
        console.error("Failed to load sources:", err);
        setError(err);
      })
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const deleteSource = async (id) => {
    setDeleting(id);
    try {
      await api.deleteSource(id);
      setSources((prev) => prev.filter((s) => s.id !== id));
      onChange?.();
    } catch {
      setDeleting(null);
    }
  };

  const goals = (state?.goals || []).filter((g) => g.status !== "dropped");
  const goalTitle = (goalId) => {
    if (!goalId) return null;
    return goals.find((g) => g.id === goalId)?.title || null;
  };

  return (
    <div data-testid="sources-view" className="px-4 sm:px-6 py-5 sm:py-6 space-y-5 max-w-[820px] mx-auto w-full">
      <p className="text-[14px] text-[var(--text-secondary)] max-w-lg leading-relaxed">
        Material you attach to a goal so the coach can work out where it starts and ends. The
        coach reads these to confirm the goal&apos;s boundary — not your memories.
      </p>

      {loading && sources.length === 0 && (
        <div
          data-testid="sources-skeleton"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
          aria-busy="true"
          aria-live="polite"
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] rounded-lg p-3 space-y-2.5"
            >
              <div className="flex items-start gap-2.5">
                <div className="w-8 h-8 rounded gc-skeleton shrink-0 mt-0.5" />
                <div className="flex-1 space-y-1.5 min-w-0">
                  <div className="h-3 w-4/5 gc-skeleton" />
                  <div className="h-2.5 w-1/3 gc-skeleton" />
                </div>
              </div>
              <div className="h-2.5 w-1/2 gc-skeleton pt-1" />
            </div>
          ))}
        </div>
      )}

      {loading && sources.length > 0 && (
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-[var(--text-muted)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          refreshing…
        </div>
      )}

      {!loading && error && (
        <div className="border border-[var(--border)] rounded-lg p-6 text-center space-y-3 bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)]" data-testid="sources-error">
          <p className="text-xs text-[var(--text-secondary)]">Couldn't load sources</p>
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

      {!loading && !error && sources.length === 0 && (
        <div className="rounded-2xl bg-[var(--bg-secondary)] p-8 sm:p-12 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center mb-3">
            <FolderOpen className="w-6 h-6 text-[var(--text-muted)]" />
          </div>
          <p className="text-[15px] text-[var(--text-secondary)] leading-relaxed max-w-sm mx-auto">
            No sources yet. Attach files or paste links when adding a goal — the coach
            will read them and reason from the ground up.
          </p>
        </div>
      )}

      {sources.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {sources.map((s) => (
            <SourceCard
              key={s.id}
              source={s}
              goalTitle={goalTitle(s.goal_id)}
              onDelete={() => deleteSource(s.id)}
              deleting={deleting === s.id}
              onView={(src) => {
                if (src.kind === "link") {
                  // Fetch the full row (incl. text_excerpt) then open the
                  // exploration dialog seeded with what the coach already read.
                  setExploringSource(src);
                  api
                    .getSource(src.id)
                    .then((full) => setExploringSource(full))
                    .catch(() => {});
                } else {
                  setViewingSource(src);
                }
              }}
            />
          ))}
        </div>
      )}

      <SourceViewerDialog
        source={viewingSource}
        onClose={() => setViewingSource(null)}
      />

      <LinkPreviewDialog
        open={!!exploringSource}
        existingSource={exploringSource}
        onClose={() => setExploringSource(null)}
        onSaved={() => {
          setExploringSource(null);
          refresh();
          onChange?.();
        }}
      />
    </div>
  );
}

function SourceCard({ source, goalTitle, onDelete, deleting, onView }) {
  const isFile = source.kind === "file";
  const isLink = source.kind === "link";

  /* Files are stored with `original_filename`; `name` only exists on link
     sources. Reading `name` first meant every uploaded file rendered as
     "Untitled file" even though the API had the name the whole time. */
  const displayName =
    (isFile ? source.original_filename : source.name) ||
    source.name ||
    (isLink ? source.url : "Untitled file");

  const displayDate = source.created_at
    ? new Date(source.created_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  const downloadUrl = isFile ? `${API}/sources/${source.id}/download` : null;

  return (
    <div
      data-testid={`source-card-${source.id}`}
      className="border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] rounded-lg p-3 space-y-2 group"
    >
      {/* Header row: kind icon + name + kebab on the right (mobile only).
          The kebab collapses the 3-4 inline actions into one tap target
          on phones where horizontal space is tight. On sm+ the kebab
          hides and the inline row takes over. */}
      <div className="flex items-start gap-2.5">
        <div
          className={`w-8 h-8 rounded flex items-center justify-center shrink-0 mt-0.5 ${
            isFile
              ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)]"
              : "bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning)]"
          }`}
        >
          {isFile ? (
            <FileText className="w-4 h-4" />
          ) : (
            <Link2 className="w-4 h-4" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-[var(--text-primary)] leading-snug line-clamp-2 break-all">
            {displayName}
          </p>
          <div className="flex items-center gap-1.5 mt-1">
            {displayDate && (
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                {displayDate}
              </span>
            )}
          </div>
        </div>
        <SourceActions
          source={source}
          isFile={isFile}
          isLink={isLink}
          downloadUrl={downloadUrl}
          onView={onView}
          onDelete={onDelete}
          deleting={deleting}
        />
      </div>

      {/* Goal linkage — sources exist to define a goal's boundary, so an
          unlinked source should say so rather than showing nothing. The
          NOT LINKED chip uses warning color so it scans as actionable
          rather than reading like a third metadata category. */}
      {goalTitle ? (
        <div className="text-[11px] text-[var(--text-secondary)] pl-0.5">
          <span className="text-[var(--text-muted)] font-mono uppercase tracking-widest text-[9px]">goal</span>{" "}
          {goalTitle}
        </div>
      ) : (
        <div className="flex items-start gap-1.5 pl-0.5 text-[11px]">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] text-[var(--warning)] font-mono uppercase tracking-widest text-[9px] shrink-0 mt-0.5">
            <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />
            not linked
          </span>
          <span className="text-[var(--text-muted)] leading-snug">
            attach it to a goal so the coach can set that goal&apos;s boundary
          </span>
        </div>
      )}

      {/* Inline actions — only render on sm+ where there's room. Mobile
          gets the same actions via the kebab above. */}
      <div className="hidden sm:flex items-center gap-2 pt-1">
        {isLink && source.url && (
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-h-11 flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
          >
            <ExternalLink className="w-3 h-3" />
            Open link
          </a>
        )}
        {isFile && downloadUrl && (
          <>
            {/* Iteration 7 (Ask 4) — View now opens an in-app preview
                dialog (like Memories' lightbox) instead of a new tab.
                Clicking the file inline keeps the user's place in the
                grid; only the explicit Download anchor goes to a new
                nav (and even then, only because the browser handles
                Content-Disposition / file-save). */}
            <button
              type="button"
              onClick={() => onView?.(source)}
              data-testid={`source-view-${source.id}`}
              className="min-h-11 inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
            >
              <Eye className="w-3 h-3" />
              View file
            </button>
            <a
              href={downloadUrl}
              download
              data-testid={`source-download-${source.id}`}
              className="min-h-11 flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
            >
              <Download className="w-3 h-3" />
              Download
            </a>
          </>
        )}
        <button
          onClick={onDelete}
          disabled={deleting}
          className={`min-h-11 ml-auto flex items-center gap-1 text-[11px] transition-colors ${
            deleting
              ? "text-[var(--text-muted)]"
              : "text-[var(--text-muted)] hover:text-[var(--danger)]"
          }`}
          title="Delete source"
        >
          {deleting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Trash2 className="w-3 h-3" />
          )}
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * SourceActions — kebab menu (mobile only) that holds the same actions as
 * the inline row. Sm+ renders nothing here (the inline row takes over).
 * Closing on outside-click + Esc + item click so the menu never traps.
 */
function SourceActions({ source, isFile, isLink, downloadUrl, onView, onDelete, deleting }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // sm+ → no kebab, the inline row handles it.
  return (
    <div ref={ref} className="relative sm:hidden shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${source.original_filename || source.name || source.url || "source"}`}
        data-testid={`source-actions-${source.id}`}
        className="h-11 w-11 shrink-0 -mr-1 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-primary)_60%,transparent)] rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        <MoreVertical className="w-4 h-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          data-testid={`source-actions-menu-${source.id}`}
          className="absolute right-0 top-9 z-10 min-w-[160px] border border-[var(--border)] bg-[var(--bg-secondary)] rounded-md shadow-xl py-1 text-xs"
        >
          {isFile && downloadUrl && (
            <>
              <button
                role="menuitem"
                type="button"
                onClick={() => { setOpen(false); onView?.(source); }}
                className="min-h-11 w-full flex items-center gap-2 px-3 py-2 hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-left"
              >
                <Eye className="w-3.5 h-3.5" /> View file
              </button>
              <a
                role="menuitem"
                href={downloadUrl}
                download
                onClick={() => setOpen(false)}
                className="min-h-11 w-full flex items-center gap-2 px-3 py-2 hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
              >
                <Download className="w-3.5 h-3.5" /> Download
              </a>
            </>
          )}
          {isLink && source.url && (
            <a
              role="menuitem"
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="min-h-11 w-full flex items-center gap-2 px-3 py-2 hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open link
            </a>
          )}
          <button
            role="menuitem"
            type="button"
            onClick={() => { setOpen(false); onDelete?.(); }}
            disabled={deleting}
            className="min-h-11 w-full flex items-center gap-2 px-3 py-2 hover:bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] text-[var(--danger)] disabled:opacity-50"
          >
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * SourceViewerDialog — inline preview for a file source.
 *
 * Mirrors the Memories lightbox pattern (Iteration 5) so the user
 * doesn't leave the Sources tab to look at a file. Renders the file
 * inside an <iframe> pointed at the same authenticated download URL
 * the browser uses for the explicit Download anchor — cookies ride
 * along, so the file streams in. For image kinds the browser shows
 * them natively; for PDFs the iframe gets the default PDF viewer;
 * for text/JSON the iframe shows the raw text.
 *
 * The dialog is opened by passing `source` via the parent state and
 * closed by setting it back to null. ESC + backdrop click both close
 * (matching the rest of the app's dialog conventions).
 */
function SourceViewerDialog({ source, onClose }) {
  useEffect(() => {
    if (!source) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [source, onClose]);

  if (!source) return null;
  const isFile = source.kind === "file";
  const url = isFile ? `${API}/sources/${source.id}/download` : source.url;
  const name =
    source.original_filename || source.name || source.url || "Source";

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget) onClose?.();
  };

  return (
    <div
      data-testid="source-viewer-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${name}`}
      onClick={handleBackdrop}
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex flex-col p-4 sm:p-8"
    >
      {/* Header chrome — name + actions */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex items-start gap-3 mb-3"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white/90 line-clamp-2">{name}</div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-white/60">
            <span>{isFile ? "file" : "link"}</span>
            {source.created_at && (
              <span>
                {new Date(source.created_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
            )}
          </div>
        </div>
        {isFile && (
          <a
            href={url}
            download
            data-testid="source-viewer-download"
            onClick={(e) => e.stopPropagation()}
            aria-label="Download file"
            title="Download the original file"
            className="h-11 w-11 flex items-center justify-center rounded bg-black/60 text-white/80 hover:text-white hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
          </a>
        )}
        <button
          type="button"
          data-testid="source-viewer-close"
          onClick={onClose}
          aria-label="Close preview"
          className="h-11 w-11 flex items-center justify-center rounded bg-black/60 text-white/80 hover:text-white hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      {/* Body — iframe works for images, PDFs, and text-based files.
          max-h keeps it inside the viewport so the chrome stays visible. */}
      <iframe
        title={`Preview: ${name}`}
        src={url}
        className="flex-1 w-full bg-white rounded shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
