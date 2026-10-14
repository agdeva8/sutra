import { useRef, useState } from "react";
import { useWebcamCapture } from "./WebcamCaptureDialog";
import { ArrowUp, Camera, Mic, Paperclip } from "lucide-react";
import AutoTextarea from "./AutoTextarea";
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
 * Presentation only: the parent owns the data and the capture write. The
 * composer does not clear until `onCapture` resolves (PRD §12) so a failed
 * write never loses the sentence.
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

export default function Scratch({
  inbox = [],
  handled = [],
  initialTab = "write",
  onCapture,
  onPhoto,
  onAttach,
  onAnswer,
  onRetry,
  onUndo,
  onAccept,
  className = DEFAULT_HEIGHT,
}) {
  const [tab, setTab] = useState(initialTab);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onCapture?.({ kind: "text", body });
      setText("");
    } catch {
      // The write failed: leave the text in the composer so nothing is lost.
      // Surfacing the error is the parent's job (it owns the request).
    } finally {
      setSending(false);
    }
  }

  const fileInput = useRef(null);
  const { openCamera, cameraUi } = useWebcamCapture((f) => onPhoto?.(f));
  const voice = useSpeechCapture({ onFinal: (transcript) => onCapture?.({ kind: "audio", body: transcript }) });
  const pick = (handler) => (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) handler?.(f);
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
          <section aria-label="Capture" className="px-4 py-4 space-y-3">
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
              minRows={5}
              maxRows={12}
              className="w-full px-3.5 py-2 text-[15px] leading-[22px] rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus-visible:border-[var(--accent)]"
            />
            <div className="flex items-center gap-2">
              {cameraUi}
              <input ref={fileInput} type="file" hidden aria-label="Choose a file" onChange={pick(onAttach)} />
              <ToolButton icon={Camera} label="Photo" onClick={openCamera} />
              <ToolButton icon={Paperclip} label="Attach" onClick={() => fileInput.current?.click()} />
              <ToolButton
                icon={Mic}
                label={voice.listening ? "Listening…" : "Hold to talk"}
                active={voice.listening}
                disabled={!voice.supported}
                title={voice.supported ? undefined : "Voice isn't supported in this browser"}
                onPointerDown={voice.start}
                onPointerUp={voice.stop}
                onPointerLeave={voice.stop}
              />
              <button
                type="button"
                onClick={send}
                disabled={!text.trim() || sending}
                aria-label="Send"
                className="ml-auto inline-flex items-center justify-center w-9 h-9 rounded-full bg-[var(--accent)] text-white disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
              >
                <ArrowUp className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
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
                <HandledCard key={h.id} item={h} onUndo={onUndo} onAccept={onAccept} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function ToolButton({ icon: Icon, label, active = false, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-full border text-[13px] touch-none select-none disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
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
      className={`h-7 px-3 rounded-full text-[12px] border focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
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
            <span className={`inline-block mt-1 px-2.5 py-0.5 rounded-full text-[12px] ${tone}`}>
              {entry.stateLabel}
            </span>
          </div>
        )}
        {entry.state === "needs_input" && entry.options?.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {entry.options.map((o) => (
              <Chip key={o} onClick={() => onAnswer?.(entry.id, o)}>
                {o}
              </Chip>
            ))}
          </div>
        )}
        {entry.state === "needs_input" && !entry.options?.length && <ReplyBox onSend={(a) => onAnswer?.(entry.id, a)} />}
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
function ReplyBox({ onSend }) {
  const [v, setV] = useState("");
  const submit = () => {
    const a = v.trim();
    if (a) onSend(a);
  };
  return (
    <div className="mt-1.5 flex gap-1.5">
      <input
        aria-label="Your answer"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Your answer"
        className="min-w-0 flex-1 h-8 px-3 rounded-full text-[13px] bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus-visible:border-[var(--accent)]"
      />
      <Chip primary onClick={submit}>Send</Chip>
    </div>
  );
}

/**
 * A handled pair: the user's words, then what the agent concluded. `item.proposal`
 * marks the one disposition that changed nothing yet (PRD §10).
 */
function HandledCard({ item, onUndo, onAccept }) {
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
            <Chip onClick={() => onUndo?.(item.id)}>Dismiss</Chip>
          </>
        ) : (
          <Chip onClick={() => onUndo?.(item.id)}>Undo</Chip>
        )}
      </div>
    </li>
  );
}
