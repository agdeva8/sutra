import { useEffect, useState } from "react";
import { Link2, Loader2, ExternalLink, FileText } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import { api } from "../lib/api";

/**
 * LinkPreviewDialog — founder feedback (Iteration 9, item #4):
 * "when the user enters the url instead of showing attaching, it
 * should show checking and then in the screen dialog box should show
 * what it was able to fetch from it, if not then it should should that
 * and then the user can attach".
 *
 * Replaces the silent-on-success / toast-only flow with an explicit
 * "what did we find?" step before the link becomes a source. The user
 * can still attach it after a failed fetch — sometimes a paywalled URL
 * or a 200-from-CDN is still useful — but the failure is visible.
 *
 * Props:
 *   open     — controlled open state
 *   onClose  — close handler
 *   url      — the URL the user pasted
 *   onAttach — async () => void; the parent performs the actual
 *              POST /api/sources/link call. The dialog closes after a
 *              successful attach.
 */
export default function LinkPreviewDialog({ open, onClose, url = "", onAttach }) {
  const [status, setStatus] = useState("idle"); // "idle" | "checking" | "ok" | "fail"
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [attaching, setAttaching] = useState(false);

  useEffect(() => {
    if (!open || !url) return;
    let cancelled = false;
    setStatus("checking");
    setPreview(null);
    setError("");
    api
      .previewLink(url)
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        setStatus(data?.ok ? "ok" : "fail");
        if (!data?.ok) setError(data?.error || "Couldn't read that link.");
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus("fail");
        setError(typeof e?.message === "string" ? e.message : "Couldn't fetch that link.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, url]);

  const attach = async () => {
    if (attaching) return;
    setAttaching(true);
    try {
      await onAttach?.();
      onClose?.();
    } catch (e) {
      setError(typeof e?.message === "string" ? e.message : "Couldn't attach that link.");
    } finally {
      setAttaching(false);
    }
  };

  return (
    <CenteredDialog
      open={open}
      onClose={attaching ? undefined : onClose}
      icon={Link2}
      title="Add this link as a source?"
      subtitle={url}
      maxWidth="max-w-xl"
      testId="link-preview-dialog"
    >
      <div className="space-y-3" data-testid="link-preview-status">
        {status === "checking" && (
          <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" aria-hidden="true" />
            <span data-testid="link-preview-checking">Checking…</span>
          </div>
        )}
        {status === "ok" && preview && (
          <div data-testid="link-preview-ok" className="space-y-2">
            <div className="rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <div className="flex items-start gap-2">
                <FileText className="w-4 h-4 text-[var(--accent)] shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {preview.title || preview.url || "Untitled"}
                  </div>
                  {preview.description && (
                    <p className="mt-1 text-xs text-[var(--text-secondary)] line-clamp-3">
                      {preview.description}
                    </p>
                  )}
                  <div className="mt-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                    {preview.content_type || "link"}{preview.status ? ` · HTTP ${preview.status}` : ""}
                  </div>
                </div>
              </div>
            </div>
            {preview.snippet?.trim() ? (
              <div data-testid="link-preview-snippet" className="max-h-36 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-xs leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap">
                {preview.snippet}
              </div>
            ) : (
              <p className="text-xs text-[var(--warning)]">
                The page responded, but no readable text was fetched. The coach will only receive the URL; paste or upload the relevant content for a grounded plan.
              </p>
            )}
            {preview.snippet?.trim() && (
              <p className="text-xs text-[var(--text-muted)]">
                This excerpt was fetched from the page and will be available to the coach as context.
              </p>
            )}
          </div>
        )}
        {status === "fail" && (
          <div data-testid="link-preview-fail" className="space-y-2">
            <p className="text-sm text-[var(--text-secondary)]">
              We couldn&apos;t read this link. Some sites block bots, some need a login, some time out before the coach can ingest them.
            </p>
            {error && (
              <p className="text-xs text-[var(--danger)] font-mono">{error}</p>
            )}
            <p className="text-xs text-[var(--text-muted)]">
              You can attach the URL, but the coach will not have the page content. Paste or upload the relevant text instead of relying on an unreadable link.
            </p>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          {status === "ok" && preview?.url && (
            <a
              href={preview.url}
              target="_blank"
              rel="noreferrer noopener"
              className="min-h-11 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
              Open
            </a>
          )}
          <button
            type="button"
            data-testid="link-preview-cancel"
            onClick={onClose}
            disabled={attaching}
            className="min-h-11 px-3 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="link-preview-attach"
            onClick={attach}
            disabled={attaching || status === "checking"}
            className="flex items-center gap-1.5 min-h-11 px-4 text-xs font-medium bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            {attaching ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Attaching…
              </>
            ) : (
              <>
                <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                {status === "ok" && preview?.snippet?.trim() ? "Attach fetched text" : "Attach URL only"}
              </>
            )}
          </button>
        </div>
      </div>
    </CenteredDialog>
  );
}
