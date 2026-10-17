import { useRef, useState } from "react";
import { useWebcamCapture } from "./WebcamCaptureDialog";
import { ArrowUp, Camera, FileText, Link2, Loader2, Mic, Paperclip, Square, X, AlertCircle, Check } from "lucide-react";
import LinkPreviewDialog from "./LinkPreviewDialog";
import { MAX_ATTACHMENTS_PER_NOTE, MAX_NOTE_CHARS, NOTE_COUNTER_FROM, uploadProblem } from "../constants/limits";
import AutoTextarea from "./AutoTextarea";
import MeetScratchCard from "./MeetScratchCard";
import { useSpeechCapture } from "../hooks/useSpeechCapture";

/**
 * Scratch — reflex capture with async inference (docs/prd/scratchpad.md).
 *
 * Mobile-first: one column under its own top nav, three views instead of a
 * split screen. Write = the capture composer, Waiting = what is still in
 * scratch, Handled = what was filed and what the agent made of it. An entry is
 * in exactly one of Waiting / Handled, and a handled card always shows the
 * user's own words directly above the inference, which is the provenance model
 * made visible (PRD §7, §11).
 *
 * Presentation only: the parent owns the data and the capture write. A failed
 * write leaves the text and attachments in the composer (PRD §12) so the
 * sentence is never lost.
 */

const COMPOSER_PLACEHOLDER = "Say whatever. It gets filed for you.";
/** Standalone height; a host screen passes its own through `className`. */
const DEFAULT_HEIGHT = "h-[calc(100vh-2rem)]";

/** The top nav's tabs, in order. Write is first: opening Scratch is for dumping. */
const TABS = [
  { key: "write", label: "Write" },
  { key: "waiting", label: "Waiting" },
  { key: "handled", label: "Handled" },
];

/** The row state words (PRD §7): a state is always a phrase, never a bare spinner. */
const STATE_TONE = {
  processing: "text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]",
  needs_input: "text-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_14%,transparent)]",
  failed: "text-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]",
};

/** Attachment states shown on the chip under the composer. */
const ATTACH_LABEL = { uploading: "Uploading…", ready: "Attached", error: "Couldn't attach" };

export default function Scratch({
  inbox = [],
  handled = [],
  initialTab = "write",
  onSend,
  onUpload,
  onAddLink,
  onAnswer,
  onRetry,
  onUndo,
  onDismiss,
  onAccept,
  className = DEFAULT_HEIGHT,
}) {
  const [tab, setTab] = useState(initialTab);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // Files, photos and links added to this note. Each is uploaded as soon as it is picked, so "Send" only
  // waits for ones still in flight and the user sees every one of them attached (or not).
  const [attachments, setAttachments] = useState([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const patchAttachment = (key, patch) => setAttachments((all) => all.map((a) => (a.key === key ? { ...a, ...patch } : a)));

  const atLimit = attachments.length >= MAX_ATTACHMENTS_PER_NOTE;

  async function attachFile(file, kind) {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const preview = kind === "image" ? URL.createObjectURL(file) : "";
    // The count and the size are judged before the upload starts, so the person is told rather than
    // left watching a bar that will only end in a rejection.
    const problem = uploadProblem(file, attachments.length);
    if (problem) {
      setAttachments((all) => [...all, { key, kind, name: file.name, preview, status: "error", error: problem }]);
      return;
    }
    setAttachments((all) => [...all, { key, kind, name: file.name, preview, status: "uploading", percent: 0 }]);
    try {
      const source = await onUpload?.(file, (percent) => patchAttachment(key, { percent }));
      patchAttachment(key, { status: "ready", percent: 100, id: source.id });
    } catch (e) {
      patchAttachment(key, { status: "error", error: e?.message || "Upload failed" });
    }
  }

  async function attachLink(url, excerpt) {
    if (atLimit) return;
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setAttachments((all) => [...all, { key, kind: "link", name: url, status: "uploading" }]);
    try {
      const source = await onAddLink?.(url, excerpt);
      patchAttachment(key, { status: "ready", id: source.id });
    } catch (e) {
      patchAttachment(key, { status: "error", error: e?.message || "Couldn't add that link" });
    }
  }

  const removeAttachment = (key) => setAttachments((all) => all.filter((a) => a.key !== key));
  const uploading = attachments.some((a) => a.status === "uploading");
  const ready = attachments.filter((a) => a.status === "ready");
  const canSend = (text.trim() || ready.length > 0) && !uploading && !sending;

  async function send() {
    if (!canSend) return;
    setSending(true);
    try {
      await onSend?.({ text: text.trim(), attachments: ready });
      setText("");
      setAttachments([]);
      // What happens next is on the Waiting tab: show it, so the note never seems to vanish.
      setTab("waiting");
    } catch {
      // The write failed: leave the text and attachments in the composer so nothing is lost.
      // Surfacing the error is the parent's job (it owns the request).
    } finally {
      setSending(false);
    }
  }

  const fileInput = useRef(null);
  const { openCamera, cameraUi } = useWebcamCapture((f) => attachFile(f, "image"));
  // Voice dictates into the composer — tap to start, tap again to stop — so the words are editable
  // before they are sent. Same control and same behaviour as the chat composer; see `useSpeechCapture`
  // for why it is a tap and not a press-and-hold.
  const voice = useSpeechCapture({ onTranscript: setText, maxChars: MAX_NOTE_CHARS });
  const isImage = (f) => (f.type || "").startsWith("image/");
  const pickFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) attachFile(f, isImage(f) ? "image" : "file");
  };

  const counts = { waiting: inbox.length };

  return (
    <div
      data-testid="scratch-view"
      className={`flex flex-col w-full max-w-[560px] mx-auto min-h-[520px] ${className} bg-[var(--bg-primary)]`}
    >
      <nav
        role="tablist"
        aria-label="Scratch"
        className="flex shrink-0 gap-1 px-4 pt-3 border-b border-[var(--border)]"
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`scratch-tab-${t.key}`}
              aria-selected={active}
              aria-controls="scratch-panel"
              onClick={() => setTab(t.key)}
              className={`relative h-10 px-3.5 text-[14px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-t-md ${
                active ? "text-[var(--text-primary)] font-semibold" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {t.label}
              {counts[t.key] > 0 && (
                <span className="ml-1.5 inline-block min-w-[18px] px-1 rounded-full text-[11px] leading-[18px] text-center bg-[var(--bg-tertiary)] text-[var(--text-secondary)] tabular-nums">
                  {counts[t.key]}
                </span>
              )}
              {active && <span className="absolute left-2 right-2 bottom-[-1px] h-0.5 rounded-full bg-[var(--accent)]" />}
            </button>
          );
        })}
      </nav>

      <div
        id="scratch-panel"
        role="tabpanel"
        aria-labelledby={`scratch-tab-${tab}`}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        {tab === "write" && (
          <section aria-label="Capture" data-testid="scratch-composer" className="px-4 py-4 space-y-3">
            <AutoTextarea
              aria-label="Capture a thought"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={COMPOSER_PLACEHOLDER}
              maxLength={MAX_NOTE_CHARS}
              minRows={5}
              maxRows={12}
              className="w-full px-3.5 py-2 text-[15px] leading-[22px] rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus-visible:border-[var(--accent)]"
            />
            {text.length >= MAX_NOTE_CHARS * NOTE_COUNTER_FROM && (
              <p className="text-right text-[12px] text-[var(--text-muted)] tabular-nums">{text.length} / {MAX_NOTE_CHARS}</p>
            )}
            {attachments.length > 0 && (
              <ul className="space-y-1.5" data-testid="scratch-attachments">
                {attachments.map((a) => (
                  <AttachmentChip key={a.key} a={a} onRemove={() => removeAttachment(a.key)} />
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              {cameraUi}
              <input ref={fileInput} type="file" hidden aria-label="Choose a file" onChange={pickFile} />
              <ToolButton icon={Camera} label="Photo" disabled={atLimit} onClick={openCamera} />
              <ToolButton icon={Paperclip} label="Attach" disabled={atLimit} onClick={() => fileInput.current?.click()} />
              <ToolButton icon={Link2} label="Link" disabled={atLimit} onClick={() => setLinkOpen(true)} />
              <ToolButton
                icon={voice.listening ? Square : Mic}
                label={voice.listening ? "Stop" : "Talk"}
                active={voice.listening}
                disabled={!voice.supported}
                title={voice.supported ? undefined : "Voice isn't supported in this browser"}
                aria-pressed={voice.listening}
                onClick={() => voice.toggle(text)}
              />
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                aria-label="Send"
                className="ml-auto inline-flex items-center justify-center w-11 h-11 rounded-full bg-[var(--accent)] text-white disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
              >
                {sending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ArrowUp className="w-4 h-4" aria-hidden="true" />}
              </button>
            </div>
            {/* While nothing has been dumped yet, Scratch introduces itself, every time. It goes away by itself
                once there is a first entry, so it is never in the way of a user who already knows it. */}
            {inbox.length === 0 && handled.length === 0 && <MeetScratchCard />}
            {atLimit && <p className="text-[12px] text-[var(--text-muted)]">That's the most one note can hold ({MAX_ATTACHMENTS_PER_NOTE} attachments). Send it, then add more in another note.</p>}
            {uploading && <p className="text-[12px] text-[var(--text-muted)]">Waiting for your attachment to finish uploading…</p>}
            <LinkPreviewDialog
              open={linkOpen}
              onClose={() => setLinkOpen(false)}
              title="Add a link to this note"
              onAttach={async (excerpt, url) => {
                setLinkOpen(false);
                attachLink(url, excerpt);
              }}
            />
          </section>
        )}

        {tab === "waiting" && (
          <section aria-label="Still in scratch" className="px-4 py-3">
            {inbox.length === 0 && <EmptyNote>Nothing waiting. Everything is filed.</EmptyNote>}
            <ul>
              {inbox.map((e) => (
                <InboxRow key={e.id} entry={e} onAnswer={onAnswer} onRetry={onRetry} />
              ))}
            </ul>
          </section>
        )}

        {tab === "handled" && (
          <section aria-label="Handled" className="px-4 py-3">
            {handled.length === 0 && <EmptyNote>Handled entries appear here with what was done.</EmptyNote>}
            <ul>
              {handled.map((h) => (
                <HandledCard key={h.id} item={h} onUndo={onUndo} onDismiss={onDismiss} onAccept={onAccept} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** One attachment under the composer: what it is, and whether it is attached yet. */
function AttachmentChip({ a, onRemove }) {
  const tone = a.status === "error" ? "text-[var(--danger)]" : a.status === "ready" ? "text-[var(--accent)]" : "text-[var(--text-muted)]";
  return (
    <li data-testid={`scratch-attachment-${a.status}`} className="relative flex items-center gap-2.5 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2">
      {a.preview ? (
        <img src={a.preview} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
          {a.kind === "link" ? <Link2 className="h-4 w-4" aria-hidden="true" /> : <FileText className="h-4 w-4" aria-hidden="true" />}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-[var(--text-primary)]">{a.name}</p>
        <p className={`flex items-center gap-1 text-[12px] ${tone}`}>
          {a.status === "uploading" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          {a.status === "ready" && <Check className="h-3 w-3" aria-hidden="true" />}
          {a.status === "error" && <AlertCircle className="h-3 w-3" aria-hidden="true" />}
          {a.status === "error"
            ? a.error || ATTACH_LABEL.error
            : a.status === "uploading" && a.percent > 0
              ? `Uploading ${a.percent}%`
              : ATTACH_LABEL[a.status]}
        </p>
      </div>
      <button type="button" onClick={onRemove} aria-label={`Remove ${a.name}`} className="h-9 w-9 shrink-0 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      {a.status === "uploading" && (
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--bg-tertiary)]">
          <span
            className="block h-full bg-[var(--accent)] transition-[width] duration-200 ease-out"
            style={{ width: `${a.percent || 0}%` }}
          />
        </span>
      )}
    </li>
  );
}

function ToolButton({ icon: Icon, label, active = false, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center gap-1.5 h-11 px-3.5 rounded-full border text-[13px] touch-none select-none disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
        active
          ? "border-[var(--accent)] text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
          : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
      }`}
    >
      <Icon className="w-4 h-4" aria-hidden="true" />
      {label}
    </button>
  );
}

function EmptyNote({ children }) {
  return <p className="py-3 text-[13px] text-[var(--text-muted)]">{children}</p>;
}

function Time({ children }) {
  return (
    <span className="w-11 shrink-0 pt-0.5 text-[11px] text-[var(--text-muted)] tabular-nums">{children}</span>
  );
}

function Chip({ children, primary = false, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      className={`min-h-11 px-4 rounded-full text-[13px] border disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
        primary
          ? "bg-[var(--accent)] border-[var(--accent)] text-white font-medium"
          : "border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
      }`}
    >
      {children}
    </button>
  );
}

/** One waiting entry. `entry.state` is processing | needs_input | failed | pending. */
function InboxRow({ entry, onAnswer, onRetry }) {
  const tone = STATE_TONE[entry.state];
  return (
    <li className="flex gap-2.5 py-2.5 border-t border-[var(--border)] first:border-t-0">
      <Time>{entry.time}</Time>
      <div className="min-w-0 flex-1 text-[14px] text-[var(--text-primary)] [overflow-wrap:anywhere]">
        {entry.body}
        {entry.stateLabel && (
          <div>
            <span className={`inline-flex items-center gap-1.5 mt-1 px-2.5 py-0.5 rounded-full text-[12px] ${tone}`} aria-live="polite">
              {entry.state === "processing" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
              {entry.stateLabel}
            </span>
          </div>
        )}
        {entry.answering && (
          <div>
            <span className="inline-flex items-center gap-1.5 mt-1 px-2.5 py-0.5 rounded-full text-[12px] text-[var(--accent)]" role="status">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Thinking about your answer…
            </span>
          </div>
        )}
        {entry.state === "needs_input" && entry.options?.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {entry.options.map((o) => (
              <Chip key={o} disabled={entry.answering} onClick={() => onAnswer?.(entry.id, o)}>
                {o}
              </Chip>
            ))}
          </div>
        )}
        {entry.state === "needs_input" && !entry.options?.length && <ReplyBox busy={entry.answering} onSend={(a) => onAnswer?.(entry.id, a)} />}
        {entry.state === "failed" && (
          <div className="mt-1.5">
            <Chip onClick={() => onRetry?.(entry.id)}>Retry</Chip>
          </div>
        )}
      </div>
    </li>
  );
}

/** Free-text answer to the one question an entry is waiting on. */
function ReplyBox({ onSend, busy = false }) {
  const [v, setV] = useState("");
  const empty = !v.trim();
  const submit = () => {
    const a = v.trim();
    if (a && !busy) {
      onSend(a);
      setV("");
    }
  };
  return (
    <div className="mt-1.5 flex gap-1.5">
      <input
        aria-label="Your answer"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        disabled={busy}
        placeholder="Your answer"
        className="min-w-0 flex-1 h-11 px-4 rounded-full text-[13px] bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus-visible:border-[var(--accent)]"
      />
      <Chip primary disabled={busy || empty} onClick={submit}>Send</Chip>
    </div>
  );
}

/**
 * A handled pair: the user's words, then what the agent concluded. `item.proposal`
 * marks the one disposition that changed nothing yet (PRD §10).
 */
function HandledCard({ item, onUndo, onDismiss, onAccept }) {
  return (
    <li className="py-2.5 border-t border-[var(--border)] first:border-t-0">
      <div className="flex gap-2.5 text-[14px] text-[var(--text-primary)]">
        <Time>{item.time}</Time>
        <p className="min-w-0 [overflow-wrap:anywhere]">{item.origin}</p>
      </div>
      <div className="ml-[3.375rem] mt-1.5 pl-2.5 border-l-2 border-[var(--border)] text-[13px] text-[var(--text-secondary)] space-y-0.5">
        <p className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">{item.kind}</p>
        {item.lines.map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>
      <div className="ml-[3.375rem] mt-2 flex gap-1.5">
        {item.proposal ? (
          <>
            <Chip primary onClick={() => onAccept?.(item.id)}>
              Review
            </Chip>
            <Chip onClick={() => onDismiss?.(item.id)}>Dismiss</Chip>
          </>
        ) : (
          // Undo only when the agent wrote something to take back; a NOISE entry changed nothing.
          item.undoable !== false && <Chip onClick={() => onUndo?.(item.id)}>Undo</Chip>
        )}
      </div>
    </li>
  );
}
