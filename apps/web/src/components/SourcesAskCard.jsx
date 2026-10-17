import { useRef, useState } from "react";
import { useReopenLink } from "./ReopenableLink";
import LinkPreviewDialog from "./LinkPreviewDialog";
import { useWebcamCapture } from "./WebcamCaptureDialog";
import { Link2, Paperclip, Camera, NotebookPen, X, Loader2 } from "lucide-react";
import { SOURCE_FILE_ACCEPT, sourceChipLabel } from "../lib/sources";
import {
  LINK_EXPLAINER_LINE,
  LINK_INPUT_HINT,
  hasSeenSourcesExplainer,
  markSourcesExplainerSeen,
} from "../lib/sourcesExplainer";

/**
 * The four kinds of source, each with the example the explainer shows. The
 * first three have a button below; notes are typed in the chat, which is one
 * tap away behind "Continue".
 */
const SOURCE_KINDS = [
  { id: "links", Icon: Link2, label: "Links", example: "a job post, a course, an article." },
  { id: "files", Icon: Paperclip, label: "PDFs and documents", example: "a syllabus, your résumé, notes." },
  { id: "photos", Icon: Camera, label: "Photos", example: "a whiteboard, handwritten notes, a screenshot." },
  { id: "notes", Icon: NotebookPen, label: "Notes", example: "just type them." },
];

const SPECIFICITY_LINE =
  "The more specific your sources, the less the coach has to guess when it builds your milestones and your monthly, weekly and daily plan.";

/**
 * SourcesAskCard — the first question of Add Goal: "anything to attach?".
 *
 * Shown after the user writes the goal and before the coach starts asking
 * questions, so what they attach (a syllabus, a job description, notes, a
 * screenshot) shapes the questions and the plan. The first goal gets the full
 * explainer — what to attach and why it matters; later goals get the one line
 * and the same three buttons. "Continue" moves on with whatever is attached.
 */
export default function SourcesAskCard({ sources, onUploadFile, onAddLink, onDeleteSource, onContinue, goalContext = "" }) {
  const fileRef = useRef(null);
  const reopenLink = useReopenLink();
  const [url, setUrl] = useState("");
  const [showLinkField, setShowLinkField] = useState(false);
  const [busy, setBusy] = useState(false);
  // Read once per mount: the explainer is full until the user has been through
  // this step once, and stays full for the rest of that visit.
  const [full] = useState(() => !hasSeenSourcesExplainer());
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
  // Several files can be picked at once; upload them one after another so the
  // chips appear in the order they were chosen rather than in completion order.
  const addFiles = async (files) => {
    for (const file of files) {
      await run(() => onUploadFile(file));
    }
  };
  const openLinkField = () => {
    setShowLinkField(true);
    // Focus the field the button just revealed, so "Add link" is one tap to type.
    requestAnimationFrame(() => document.querySelector('[data-testid="sources-ask-link"]')?.focus());
  };
  const leave = () => {
    markSourcesExplainerSeen();
    onContinue?.();
  };

  const attachFromPreview = async (excerpt, attachedUrl) => {
    await run(() => onAddLink(attachedUrl || previewUrl, "", { text: excerpt }));
    setUrl("");
    setShowLinkField(false);
  };

  const camera = useWebcamCapture((f) => run(() => onUploadFile(f)));

  return (
    <div data-testid="sources-ask" className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 flex flex-col gap-3 gc-fade-up">
      {full ? (
        <div data-testid="sources-explainer">
          <p className="text-sm font-semibold text-[var(--text-primary)]">Add what you already have</p>
          <p className="text-xs text-[var(--text-secondary)] mt-1 leading-relaxed">{SPECIFICITY_LINE}</p>
          <ul data-testid="sources-explainer-kinds" className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {SOURCE_KINDS.map(({ id, Icon, label, example }) => (
              <li key={id} data-testid={`sources-kind-${id}`} className="flex items-start gap-2 rounded-lg bg-[var(--bg-primary)] px-3 py-2">
                <Icon className="w-4 h-4 mt-0.5 shrink-0 text-[var(--accent)]" strokeWidth={1.8} aria-hidden="true" />
                <span className="min-w-0 text-xs leading-snug text-[var(--text-secondary)]">
                  <span className="font-semibold text-[var(--text-primary)]">{label}:</span> {example}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p data-testid="sources-explainer-compact" className="text-xs leading-relaxed text-[var(--text-secondary)]">
          {SPECIFICITY_LINE}
        </p>
      )}

      {/* Both versions carry the link guidance: what the coach extracts is only
          as good as what the user tells it to look for. */}
      <p data-testid="sources-link-hint" className="text-xs leading-relaxed text-[var(--text-muted)]">
        {LINK_EXPLAINER_LINE}
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="sources-ask-file"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="min-h-11 inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-4 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Paperclip className="w-4 h-4" aria-hidden="true" />} Add file
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          multiple
          aria-label="Choose files to attach"
          accept={SOURCE_FILE_ACCEPT}
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = "";
            if (files.length > 0) addFiles(files);
          }}
        />
        <button
          type="button"
          data-testid="sources-ask-add-link-toggle"
          disabled={busy}
          aria-expanded={showLinkField}
          onClick={() => (showLinkField ? setShowLinkField(false) : openLinkField())}
          className="min-h-11 inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-4 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
        >
          <Link2 className="w-4 h-4" aria-hidden="true" /> Add link
        </button>
        <button
          type="button"
          data-testid="sources-ask-add-photo"
          disabled={busy}
          onClick={camera.openCamera}
          className="min-h-11 inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-4 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
        >
          <Camera className="w-4 h-4" aria-hidden="true" /> Add photo
        </button>
        {camera.cameraUi}
      </div>

      {showLinkField && (
        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            <div className="flex-1 min-w-0 flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-3">
              <Link2 className="w-4 h-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              <input
                data-testid="sources-ask-link"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addLink()}
                placeholder="Paste a link"
                aria-label="Link to attach"
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
              {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : "Add"}
            </button>
          </div>
          <p data-testid="sources-ask-link-hint" className="px-1 text-xs text-[var(--text-muted)]">
            {LINK_INPUT_HINT}
          </p>
        </div>
      )}

      {sources.length > 0 && (
        <ul className="flex flex-col gap-1.5" data-testid="sources-ask-list">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-lg bg-[var(--bg-primary)] px-3 min-h-11 text-xs text-[var(--text-secondary)]">
              <button type="button" onClick={() => reopenLink.open(s)} className="min-w-0 flex-1 truncate text-left hover:text-[var(--text-primary)] hover:underline">{sourceChipLabel(s)}</button>
              <button type="button" aria-label={`Remove ${s.original_filename || s.url}`} onClick={() => onDeleteSource(s.id)} className="h-11 w-11 -mr-2 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          data-testid="sources-ask-continue"
          disabled={busy}
          onClick={leave}
          className={
            sources.length > 0
              ? "min-h-11 rounded-full bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-40"
              : "min-h-11 rounded-full px-4 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
          }
        >
          {sources.length > 0
            ? `Continue with ${sources.length} source${sources.length === 1 ? "" : "s"}`
            : "Continue without sources"}
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
