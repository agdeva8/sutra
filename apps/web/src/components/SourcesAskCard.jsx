import { useRef, useState } from "react";
import { useReopenLink } from "./ReopenableLink";
import LinkPreviewDialog from "./LinkPreviewDialog";
import { Link2, Paperclip, X, Loader2 } from "lucide-react";

/** File types the source upload accepts; images are read by the coach the same way as documents. */
const ACCEPT = ".pdf,.md,.txt,.csv,.json,.png,.jpg,.jpeg";

/**
 * SourcesAskCard — the first question of Add Goal: "anything to attach?".
 *
 * Shown after the user writes the goal and before the coach starts asking questions, so what they
 * attach (a syllabus, a job description, notes, a screenshot) shapes the questions and the plan.
 * "Not now" skips it; "Done" continues with what was attached.
 */
export default function SourcesAskCard({ sources, onUploadFile, onAddLink, onDeleteSource, onNotNow, onDone, goalContext = "" }) {
  const fileRef = useRef(null);
  const reopenLink = useReopenLink();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  // The typed link goes through the same preview -> "what the coach read" -> ask -> attach dialog the
  // chat composer uses (ChatConsole), so a link attached here is curated the same way, not added raw.
  const [previewUrl, setPreviewUrl] = useState("");

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const addLink = () => {
    const value = url.trim();
    if (!value) return;
    setPreviewUrl(value);
  };

  const attachFromPreview = async (excerpt, attachedUrl) => {
    await run(() => onAddLink(attachedUrl || previewUrl, "", { text: excerpt }));
    setUrl("");
  };

  return (
    <div data-testid="sources-ask" className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 flex flex-col gap-3 gc-fade-up">
      <div>
        <p className="text-sm font-semibold text-[var(--text-primary)]">Want to attach anything first?</p>
        <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">
          A link, a file or an image — a syllabus, a job description, notes, a screenshot. The coach reads it to work out what this goal needs.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="sources-ask-file"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="min-h-11 inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-4 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />} {busy ? "Uploading…" : "File or image"}
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={ACCEPT}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) run(() => onUploadFile(file));
          }}
        />
      </div>

      <div className="flex gap-2">
        <div className="flex-1 min-w-0 flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-3">
          <Link2 className="w-4 h-4 shrink-0 text-[var(--text-muted)]" />
          <input
            data-testid="sources-ask-link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addLink()}
            placeholder="Paste a link"
            inputMode="url"
            className="min-h-11 w-full bg-transparent text-sm outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
        </div>
        <button
          type="button"
          data-testid="sources-ask-add-link"
          disabled={busy || !url.trim()}
          onClick={addLink}
          className="min-h-11 rounded-full border border-[var(--border)] px-4 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Add"}
        </button>
      </div>

      {sources.length > 0 && (
        <ul className="flex flex-col gap-1.5" data-testid="sources-ask-list">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-lg bg-[var(--bg-primary)] px-3 min-h-9 text-xs text-[var(--text-secondary)]">
              <button type="button" onClick={() => reopenLink.open(s)} className="min-w-0 flex-1 truncate text-left hover:text-[var(--text-primary)] hover:underline">{s.original_filename || s.url}</button>
              <button type="button" aria-label="Remove" onClick={() => onDeleteSource(s.id)} className="h-9 w-9 -mr-2 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-testid="sources-ask-skip"
          onClick={onNotNow}
          className="min-h-11 rounded-full px-4 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          Not now
        </button>
        <button
          type="button"
          data-testid="sources-ask-done"
          disabled={busy || sources.length === 0}
          onClick={onDone}
          className="min-h-11 rounded-full bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-40"
        >
          Done
        </button>
      </div>
      {reopenLink.dialog}
      <LinkPreviewDialog
        open={Boolean(previewUrl)}
        url={previewUrl}
        onClose={() => setPreviewUrl("")}
        onAttach={attachFromPreview}
        goalContext={goalContext}
      />
    </div>
  );
}
