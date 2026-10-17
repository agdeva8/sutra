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

/** The Handled card's link control: what it says when nothing is linked, and when something is. */
const LINK_GOAL_LABEL = "Link to a goal";
const LINKED_GOAL_PREFIX = "Goal:";
const CHANGE_LINK_LABEL = "Change";
const NO_GOAL_LABEL = "No goal";
const PICKER_TITLE = "Link to a goal";
const NO_ACTIVE_GOALS = "No active goals yet.";

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

/** Attachment states shown on the chip under the composer. Nothing uploads until the note is sent. */
const ATTACH_LABEL = { ready: "Ready to send", error: "Can't send this" };

export default function Scratch({
  inbox = [],
  handled = [],
  /** The user's active goals, for the Handled card's link picker. The parent owns the request. */
  goals = [],
  initialTab = "write",
  onSend,
  onAnswer,
  onRetry,
  onUndo,
  onDismiss,
  onAccept,
  onLinkGoal,
  className = DEFAULT_HEIGHT,
}) {
  const [tab, setTab] = useState(initialTab);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // Files, photos and links added to this note. Nothing leaves the phone at this point: Send writes the
  // note at once and the parent hands each attachment to the background upload queue, so picking a photo
  // never delays the sentence (see `lib/scratchUploads.js`).
  const [attachments, setAttachments] = useState([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const patchAttachment = (key, patch) => setAttachments((all) => all.map((a) => (a.key === key ? { ...a, ...patch } : a)));

  const atLimit = attachments.length >= MAX_ATTACHMENTS_PER_NOTE;

  function attachFile(file, kind) {
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const preview = kind === "image" ? URL.createObjectURL(file) : "";
    // The count and the size are judged here, before Send, so the person hears "too big" now rather
    // than after the note has already gone.
    const problem = uploadProblem(file, attachments.length);
    const chip = { key, kind, name: file.name, file, preview, status: problem ? "error" : "ready" };
    if (problem) chip.error = problem;
    setAttachments((all) => [...all, chip]);
  }

  function attachLink(url, excerpt) {
    if (atLimit) return;
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setAttachments((all) => [...all, { key, kind: "link", name: url, url, excerpt, status: "ready" }]);
  }

  /** Re-check a chip that was refused before Send. A refused file has not moved, so this is the same test. */
  function retryAttachment(a) {
    const problem = uploadProblem(a.file, attachments.length - 1);
    patchAttachment(a.key, problem ? { status: "error", error: problem } : { status: "ready", error: "" });
  }

  const removeAttachment = (key) => setAttachments((all) => all.filter((a) => a.key !== key));
  const ready = attachments.filter((a) => a.status === "ready");
  const canSend = (text.trim() || ready.length > 0) && !sending;

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
                  <AttachmentChip key={a.key} a={a} onRemove={() => removeAttachment(a.key)} onRetry={() => retryAttachment(a)} />
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
                <HandledCard
                  key={h.id}
                  item={h}
                  goals={goals}
                  onUndo={onUndo}
                  onDismiss={onDismiss}
                  onAccept={onAccept}
                  onLinkGoal={onLinkGoal}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * One attachment under the composer: what it is, and whether it is ready to go with the note.
 *
 * Nothing here is in flight any more — the upload starts only after Send — so the only failure is one
 * caught before sending (too big, or one past the per-note limit). That chip offers Retry beside the ✕.
 */
function AttachmentChip({ a, onRemove, onRetry }) {
  const tone = a.status === "error" ? "text-[var(--danger)]" : "text-[var(--accent)]";
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
          {a.status === "ready" && <Check className="h-3 w-3" aria-hidden="true" />}
          {a.status === "error" && <AlertCircle className="h-3 w-3" aria-hidden="true" />}
          {a.status === "error" ? a.error || ATTACH_LABEL.error : ATTACH_LABEL[a.status]}
        </p>
      </div>
      {a.status === "error" && (
        <button
          type="button"
          onClick={onRetry}
          className="h-9 shrink-0 rounded-full px-2 text-[12px] text-[var(--accent)] hover:bg-[var(--bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Retry
        </button>
      )}
      <button type="button" onClick={onRemove} aria-label={`Remove ${a.name}`} className="h-9 w-9 shrink-0 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
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
function HandledCard({ item, goals, onUndo, onDismiss, onAccept, onLinkGoal }) {
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
      {/* Only an entry that filed something a goal can own gets the control; a NOISE entry does not. */}
      {item.linkable > 0 && (
        <div className="ml-[3.375rem] mt-2">
          <LinkGoalControl item={item} goals={goals} onLinkGoal={onLinkGoal} />
        </div>
      )}
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

/**
 * The Handled card's "Link to a goal" control and its picker.
 *
 * The label is the whole state: nothing linked reads as an invitation, and a link reads as the goal
 * plus a quiet "Change". On a phone the picker is a bottom sheet, so the goals stay under the thumb.
 */
function LinkGoalControl({ item, goals = [], onLinkGoal }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const linked = item.goal || null;
  const label = linked ? `${LINKED_GOAL_PREFIX} ${linked.title} · ${CHANGE_LINK_LABEL}` : LINK_GOAL_LABEL;

  const choose = async (goalId) => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      await onLinkGoal?.(item.id, goalId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] px-4 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <GoalPickerSheet
          goals={goals}
          selectedId={linked?.id || null}
          onChoose={choose}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** A bottom sheet of the user's active goals plus "No goal". Every row is a 44 px target. */
function GoalPickerSheet({ goals = [], selectedId, onChoose, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={PICKER_TITLE}
        onClick={(e) => e.stopPropagation()}
        className="mx-auto w-full max-w-[560px] rounded-t-2xl border-t border-[var(--border)] bg-[var(--bg-primary)] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <p className="text-[13px] font-semibold text-[var(--text-primary)]">{PICKER_TITLE}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-full"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto px-2 pb-3">
          {goals.length === 0 && <li className="px-2 py-3 text-[13px] text-[var(--text-muted)]">{NO_ACTIVE_GOALS}</li>}
          {goals.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                onClick={() => onChoose(g.id)}
                aria-pressed={g.id === selectedId}
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-[14px] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <span className="min-w-0 flex-1 truncate">{g.title}</span>
                {g.id === selectedId && <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => onChoose(null)}
              aria-pressed={selectedId === null}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-[14px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <span className="min-w-0 flex-1 truncate">{NO_GOAL_LABEL}</span>
              {selectedId === null && <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />}
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}
