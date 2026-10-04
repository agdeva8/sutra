import { useRef, useEffect, useLayoutEffect, useState } from "react";
import { ArrowUp, Paperclip, Link2, X, FileText, Trash2, Mic, Square, Camera, Check, Send, ChevronDown, ChevronUp } from "lucide-react";
import ToolConfirmationPrompt from "./ToolConfirmationPrompt";
import ChatModeSelect from "./ChatModeSelect";
import MarkdownMessage from "./MarkdownMessage";
import CopyButton from "./CopyButton";
import SuccessBanner from "./SuccessBanner";
import ImpactPanel from "./ImpactPanel";
import LinkPreviewDialog from "./LinkPreviewDialog";

/**
 * EmptyState — the prompt shown when there are no messages yet.
 *
 * Two shapes:
 *   - Scoped (e.g. "About: Miso-eggplant dinner"): a one-line intent
 *     that says what this chat is for and what the coach will help
 *     the user do here. Mirrors AddGoalDialog's per-category
 *     subtitle — the user lands on a specific surface, not the
 *     generic "what are you working on" onboarding.
 *   - Unscoped (the header bar chat, no subject): the original
 *     generic onboarding, kept verbatim so the global chat still
 *     onboards first-time users.
 */
function EmptyState({ scopeLabel, scopeIntent }) {
  if (scopeLabel && scopeIntent) {
    return (
      <div data-testid="chat-empty-scoped" className="h-full flex flex-col justify-center max-w-lg">
        <div className="font-medium text-xs text-[var(--text-muted)] mb-3">
          About this
        </div>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          {scopeIntent}{" "}
          <span className="text-[var(--text-primary)]">
            Nothing changes until you confirm it. Refine or reject it if it isn't right.
          </span>
        </p>
        <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
          You're chatting about <span className="text-[var(--text-secondary)]">{scopeLabel}</span>.
        </p>
      </div>
    );
  }
  return (
    <div data-testid="chat-empty-generic" className="h-full flex flex-col justify-center max-w-lg">
      <div className="font-medium text-xs text-[var(--text-muted)] mb-3">Start here</div>
      <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
        Tell me about your goal and we'll build the milestones together.
      </p>
    </div>
  );
}

/**
 * ChatLoadingSkeleton — shimmer shown while the open chat's history is
 * being fetched, so the composer doesn't sit over a blank/empty state that
 * then pops into a transcript.
 */
function ChatLoadingSkeleton() {
  return (
    <div
      data-testid="chat-loading"
      aria-busy="true"
      aria-live="polite"
      className="flex flex-col items-start gap-6"
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="w-full space-y-2">
          <div className="h-3 w-14 gc-skeleton" />
          <div className="h-4 w-[85%] gc-skeleton" />
          <div className="h-4 w-[72%] gc-skeleton" />
          {i % 2 === 0 && <div className="h-4 w-[48%] gc-skeleton" />}
        </div>
      ))}
    </div>
  );
}

/**
 * SpeechWave — animated audio feedback rendered above the chat input
 * while the user is dictating. Each bar has a randomized height that
 * updates on a short interval so the visualization actually moves while
 * the model is still producing interim transcripts. Mirrors the look of
 * the assistant's streaming caret so it reads as part of the chat UI.
 */
function SpeechWave({ text }) {
  const [bars, setBars] = useState(() => Array.from({ length: 16 }, () => 0.4));

  useEffect(() => {
    const id = setInterval(() => {
      setBars((prev) =>
        prev.map(() => 0.25 + Math.random() * 0.75),
      );
    }, 110);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      data-testid="speech-wave"
      aria-live="polite"
      className="mb-2 flex items-center gap-2 px-3 py-2 border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] bg-[color-mix(in_srgb,var(--danger)_5%,transparent)] rounded-md"
    >
      <span className="text-xs uppercase text-[var(--danger)] shrink-0">
        listening
      </span>
      <div className="flex items-end gap-[3px] h-5 flex-1 min-w-0">
        {bars.map((h, i) => (
          <span
            key={i}
            className="flex-1 min-w-[2px] max-w-[6px] rounded-sm bg-[var(--danger)] transition-[height] duration-100 ease-linear"
            style={{ height: `${h * 100}%` }}
          />
        ))}
      </div>
      <span className="text-xs text-[var(--text-muted)] truncate min-w-0 max-w-[40%]" title={text}>
        {text ? text.slice(-32) : "…"}
      </span>
    </div>
  );
}

/**
 * SetLines — the typesetting pass over a coach reply.
 *
 * Coaching-as-correspondence (D3 · Marginalia): the mentor writes, the
 * interface labels. A reply is split into TYPOGRAPHIC UNITS — hard newline
 * runs (`whitespace-pre-wrap` already lays those out as separate lines) and
 * sentence boundaries — one INLINE span per unit, each carrying its
 * reading-order index. When the reply settles the reveal runs unit by unit:
 * type being set down a page, not a bubble popping in.
 *
 * Self-critique drove the sentence split: most coach replies are prose with
 * no hard newlines at all, so a newline-only split collapses to a single
 * element and the moment degrades to the generic blur-in fade. Sentences
 * are the unit a letter is actually composed in, so the cascade survives
 * the common case.
 *
 * The spans are rendered for the whole life of the message (streaming
 * included) and only GAIN the `.gc-type-line` class at the settle moment.
 * That keeps the DOM shape identical across the transition — inside an
 * aria-live log, mutating childList/characterData at completion would risk
 * re-announcing the reply; an attribute change does not.
 *
 * The split is capture-group based, so every matched separator (whitespace,
 * newline) is returned inline and the spans' text content concatenates back
 * to the original string byte for byte: text content, copy/selection and
 * screen-reader output are identical to a single text node. Animated
 * properties are opacity + filter only: paint-only, no box ever moves or
 * resizes → CLS = 0.
 *
 * `--gc-line` is set here in JS, capped at 4 units, so a long reply still
 * resolves inside the 300–500ms window — units 5+ ink in with unit 4
 * instead of pushing the reveal into a second second.
 */
const TYPE_UNITS = /([.!?]+["')\]]*\s+|\n+)/;

// B5#8 — render cap for the chat log (no virtualization lib; a slice
// keeps long sessions cheap without changing any data flow).
const CHAT_RENDER_CAP = 100;

function SetLines({ content, settled }) {
  const parts = String(content).split(TYPE_UNITS);
  return parts.map((p, i) => (
    <span
      key={i}
      className={settled ? "gc-type-line" : undefined}
      style={{ "--gc-line": String(Math.min(Math.floor(i / 2), 4)) }}
    >
      {p}
    </span>
  ));
}

function Message({ m, settled = false, onConfirm, onReject, onRefine, onOpenRefine, onOpenReject, onNavigate, onAnswerChoice, showConfirm = true, busyProposal, onViewGoal }) {
  // Success divider — appended by the parent after a confirm closes the
  // conversation bucket (spec §10.5). Rendered inline in the same
  // stream; the messages are never cleared on confirm.
  if (m.role === "success") {
    return (
      <SuccessBanner
        message={m.content}
        goalId={m.goalId}
        goalTitle={m.goalTitle}
        createdAt={m.createdAt}
        onView={m.goalId && onViewGoal ? () => onViewGoal(m.goalId) : undefined}
      />
    );
  }
  if (m.role === "user") {
    return (
      <div data-testid="chat-message-user" className="flex flex-col items-end gc-fade-up">
        <div className="flex items-center gap-1 mb-1">
          <CopyButton text={m.content} />
          <span className="font-medium text-xs text-[var(--text-muted)]">You</span>
        </div>
        <div className="max-w-[85%] bg-[var(--bg-tertiary)] px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words">
          {m.content}
        </div>
      </div>
    );
  }
  return (
    <div data-testid="chat-message-coach" className="flex flex-col items-start">
      <div className="flex items-center gap-1 mb-1">
        <span className="font-medium text-xs text-[var(--accent)]">Coach</span>
        {/* Only once the reply has settled (no point copying a stream). */}
        {!m.streaming && <CopyButton text={m.content} />}
      </div>
      {/* A4 signature moment — the reply "sets" like type. The wrapper
          deliberately no longer carries `gc-fade-up`: a completed reply
          remounts (its id swaps from the client stream id to the server id),
          so the generic fade-up used to run at exactly the same instant as
          this. One arrival, one animation — the coach's, not the bubble's. */}
      {/* Coach reply. While streaming we render the raw text (cheap per
          delta + keeps the caret); once it settles we render GFM markdown
          so tables/lists/code display properly instead of as raw pipes.
          Before the first delta arrives the bubble holds no prose — show a
          small grey status instead so the warm-up can never be mistaken
          for the coach's actual answer. */}
      {m.streaming ? (
        m.content ? (
          <div className="max-w-[92%] text-lg leading-[1.65] font-serif whitespace-pre-wrap break-words text-[var(--voice-fg)]">
            <SetLines content={m.content} settled={false} />
            <span className="gc-caret text-[var(--accent)]">▋</span>
          </div>
        ) : (
          <div
            data-testid="chat-response-pending"
            className="max-w-[92%] text-xs leading-relaxed text-[var(--text-muted)]"
          >
            Checking your goals, commitments, and attached sources…
            <span className="gc-caret text-[var(--accent)]">▋</span>
          </div>
        )
      ) : (
        <div className={`max-w-[92%] text-lg leading-[1.65] font-serif break-words text-[var(--voice-fg)]${settled ? " gc-type-set" : ""}`}>
          <MarkdownMessage content={m.content} />
        </div>
      )}
      {(m.proposals || []).length > 0 && (
        <div className="w-[92%] mt-2">
          {m.proposals.map((p) => (
            <ToolConfirmationPrompt
              key={p.id}
              proposal={p}
              busy={busyProposal === p.id}
              onConfirm={() => onConfirm(m.id, p.id)}
              onReject={() => onReject(m.id, p.id)}
              onRefine={onRefine ? (thought) => onRefine(p, thought) : undefined}
              onOpenRefine={onOpenRefine ? () => onOpenRefine(p) : undefined}
              onOpenReject={onOpenReject ? () => onOpenReject(p) : undefined}
              onNavigate={onNavigate}
              onAnswerChoice={onAnswerChoice}
              showConfirm={showConfirm}
            />
          ))}
        </div>
      )}
      {/* Structured [[IMPACT]] block emitted with this reply (spec §10.5)
          — load shifts, conflicts, buffer warnings, recommendation. */}
      {m.impact && <ImpactPanel impact={m.impact} />}
    </div>
  );
}

export default function ChatConsole({ messages, onSend, sending, input, setInput, onConfirm, onReject, onRefine, onOpenRefine, onOpenReject, onNavigate = null, onAnswerChoice = null, showConfirm = true, busyProposal, autoAnswer, setAutoAnswer, grillMe = false, setGrillMe = () => {}, onUploadFile = () => {}, onAddLink = () => {}, sources = [], onDeleteSource = () => {}, onClearChat = () => {}, pendingClarifications = null, onAnswerClarification = () => {}, onDismissClarifications = () => {}, showSources = true, focusOnMount = false, scopeLabel = "", scopeIntent = "", goalContext = "", emptyPrompt = "", loading = false, onViewGoal = null, showModeSelect = true }) {
  const endRef = useRef(null);
  const taRef = useRef(null);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [empty] = useState(messages.length === 0);
  const [isTyping, setIsTyping] = useState(false);
  const typingTimeoutRef = useRef(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const recognitionRef = useRef(null);

  // --- Clarification answers -------------------------------------------------
  // Answer-all-then-submit: tapping an option SELECTS it (never sends). Works
  // for single-choice questions (radio) and `multi: true` questions (checkbox,
  // several picks allowed). One Submit carries the whole picture to the coach
  // instead of dripping one answer per message.
  //   picked: { [questionIndex]: string[] }  — array so multi can hold several
  //   drafts: { [questionIndex]: string }    — per-question free-text alternative
  const [picked, setPicked] = useState({});
  const [drafts, setDrafts] = useState({});
  const [clarificationsCollapsed, setClarificationsCollapsed] = useState(false);
  const clarificationKey = pendingClarifications
    ? pendingClarifications.messageId || `q${pendingClarifications.questions?.length || 0}`
    : "";
  useEffect(() => {
    setPicked({});
    setDrafts({});
    setClarificationsCollapsed(false);
  }, [clarificationKey]);

  const isPicked = (i, option) => (picked[i] || []).includes(option);

  // Picking options and typing the free box are ADDITIVE per question: the
  // user may pick 1+ options, type an answer, both, or neither. Everything
  // provided goes into the submitted line for that question.
  const togglePick = (i, option, multi) =>
    setPicked((prev) => {
      const current = prev[i] || [];
      const next = multi
        ? current.includes(option)
          ? current.filter((o) => o !== option)
          : [...current, option]
        : current.includes(option)
          ? []
          : [option];
      const out = { ...prev };
      if (next.length > 0) out[i] = next;
      else delete out[i];
      return out;
    });

  const setDraft = (i, value) =>
    setDrafts((d) => (d[i] === value ? d : { ...d, [i]: value }));

  const answerFor = (i) => {
    const parts = [];
    const chosen = picked[i] || [];
    if (chosen.length > 0) parts.push(chosen.join(", "));
    const typed = (drafts[i] || "").trim();
    if (typed) parts.push(typed);
    return parts.join(", ");
  };

  const questionCount = pendingClarifications?.questions?.length || 0;
  const answeredCount = Array.from({ length: questionCount }).filter((_, i) =>
    Boolean(answerFor(i)),
  ).length;
  const answerCount = answeredCount;

  const submitClarifications = () => {
    const questions = pendingClarifications?.questions || [];
    const lines = [];
    questions.forEach((_, i) => {
      const answer = answerFor(i);
      if (answer) lines.push(`${String(i + 1).padStart(2, "0")}: ${answer}`);
    });
    if (!lines.length) return;
    setPicked({});
    setDrafts({});
    onAnswerClarification(lines.join("\n"));
  };

  // --- Attach: link composer -------------------------------------------------
  // The link button used to be `onClick={onAddLink}`, which passed the click
  // EVENT as the url — the caller then stored that event object as
  // `original_filename` and React crashed with "Objects are not valid as a
  // React child". It now opens a real input so a url is the only thing that
  // ever reaches onAddLink.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");

  const closeLink = () => {
    setLinkOpen(false);
    setLinkValue("");
  };

  // Iteration 9 — URL pre-check. Instead of silently POSTing the link
  // to /api/sources/link, open the LinkPreviewDialog which calls
  // /api/sources/link/preview and shows the user what the coach will
  // be able to read before committing. The actual POST happens when
  // the user clicks "Attach" / "Attach anyway" in the dialog.
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);

  const submitLink = () => {
    const url = linkValue.trim();
    if (!url) return;
    setPreviewUrl(url);
    setPreviewOpen(true);
    // Don't close yet — wait until the user decides in the dialog.
  };

  const closePreview = () => {
    setPreviewOpen(false);
    setPreviewUrl("");
    closeLink();
  };

  const attachFromPreview = async (excerpt) => {
    await onAddLink(previewUrl, "", { text: excerpt });
  };

  // --- Attach: drag & drop ---------------------------------------------------
  // Dropping a file anywhere on the console attaches it (same handler as the
  // paperclip). A depth counter keeps the highlight alive while the pointer
  // crosses child elements, and text/URI drags are ignored so reordering text
  // never reads as an attach.
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const isFileDrag = (e) =>
    Array.from(e.dataTransfer?.types || []).includes("Files");
  const onDragEnter = (e) => {
    if (!showSources || !isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragging(true);
  };
  const onDragOver = (e) => {
    if (!showSources || !isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e) => {
    if (!showSources || !dragging) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  };
  const onDrop = (e) => {
    if (!showSources || !isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) onUploadFile(file);
  };

  // --- A4 signature moment: the coach's reply sets like type ---------------
  // Detect the streaming -> complete transition HERE, not inside Message:
  // finishing a reply swaps the message id (client stream id -> server id),
  // so the bubble unmounts and remounts at completion and any per-instance
  // state would miss the moment entirely. A layout effect is used so the
  // class lands in the same frame the completed reply first paints — there
  // is no un-animated flash of the finished text before the effect runs.
  // Fires exactly once per reply (true -> false edge), never per token;
  // loading history or reopening a chat never streams, so nothing animates.
  const streamingNow = messages.some((m) => m.streaming);
  const wasStreamingRef = useRef(false);
  const [settledId, setSettledId] = useState(null);

  useEffect(() => {
    if (input) {
      setIsTyping(true);
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      typingTimeoutRef.current = setTimeout(() => {
        setIsTyping(false);
      }, 2000); // 2 seconds of inactivity
    } else {
      setIsTyping(false);
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    }

    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, [input]);

  useLayoutEffect(() => {
    if (wasStreamingRef.current && !streamingNow) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== "user" && m.role !== "success") {
          setSettledId(m.id);
          break;
        }
      }
    }
    wasStreamingRef.current = streamingNow;
  }, [streamingNow, messages]);

  // Scroll to bottom whenever messages change OR when sending starts (user sent a
  // message but the response hasn't arrived yet — we still want to scroll so the
  // user sees the input area disappear and knows the coach is working).
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  // When a clarification turn lands, bring the card's HEADER into view rather
  // than the transcript end — the card can be taller than the log, and the
  // prompt, progress and collapse control all live at its top.
  const clarificationRef = useRef(null);
  useEffect(() => {
    if (!clarificationKey) return undefined;
    const t = setTimeout(() => {
      clarificationRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    return () => clearTimeout(t);
  }, [clarificationKey]);

  // When focusOnMount is true (set by the parent when this console
  // mounts inside an open modal), move focus into the textarea after
  // the modal has settled. Skip if voice is already listening — the
  // mic owns the focus at that point.
  useEffect(() => {
    if (!focusOnMount) return;
    const t = setTimeout(() => {
      if (!voiceListening && taRef.current) taRef.current.focus();
    }, 80);
    return () => clearTimeout(t);
    // voiceListening intentionally omitted — we only fire on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusOnMount]);

  // Voice input via Web Speech API. We feature-detect on mount so we
  // can hide the mic button on browsers that don't support it
  // (Firefox desktop, older Safari). On the unsupported path, the
  // user can still type — no broken UI.
  //
  // Iteration 9+ voice behaviour:
  //   1. continuous: TRUE so the model keeps listening after the first
  //      final result (the default `false` cut off after one pause).
  //   2. interimResults: TRUE so the user sees partial words while
  //      speaking.
  //   3. Auto-pause = 60s with NO onresult event. The previous
  //      single-pause behaviour was too aggressive — users mid-thought
  //      were being cut off. The 60s timer is the fallback; the user
  //      can ALWAYS hit the red stop button to end early.
  //   4. Auto-restart on unexpected end (Iteration 9+): Chromium's
  //      SpeechRecognition auto-stops itself after roughly 60s of
  //      no-input regardless of our silence timer. If `onend` fires
  //      while voiceListening is still true, we restart the recognition
  //      within 250ms. The user only sees a brief "Reconnecting…"
  //      status. This eliminates the "I want to add gold I want to
  //      add gold" duplication bug where the browser cut off, the user
  //      saw the stop, and the next tap replayed the buffer.
  const expectedStopRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setVoiceSupported(false);
      return;
    }
    setVoiceSupported(true);
    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";

    let silenceTimerId = null;
    const SILENCE_LIMIT_MS = 60_000;

    const armSilenceTimer = () => {
      // 60s without an onresult event = user stopped talking for a while.
      // Pause the session so the recognition's buffer doesn't drift; the
      // user can re-tap the mic to resume from a fresh slate.
      if (silenceTimerId) clearTimeout(silenceTimerId);
      silenceTimerId = setTimeout(() => {
        expectedStopRef.current = true;
        try { recognition.stop(); } catch { /* ignore */ }
      }, SILENCE_LIMIT_MS);
    };

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      // Reset the 60s timer on every result — the user is still active.
      armSilenceTimer();

      setInput((prev) => {
        // Dedupe: if the new interim already appears in `prev` (the
        // browser sometimes re-emits the last interim on every event),
        // keep `prev` as-is. Otherwise concatenate. Fixes the
        // "I want to add gold I want to add gold" duplication bug.
        const incoming = (finalText || interimText).trim();
        if (!incoming) return prev;
        const cur = prev.trim();
        if (cur === incoming) return prev;
        if (cur.endsWith(incoming)) return prev;
        if (!cur) return incoming;
        // Append with a space if neither already ends/begins with it.
        return `${cur} ${incoming}`;
      });
    };

    recognition.onerror = (event) => {
      if (silenceTimerId) { clearTimeout(silenceTimerId); silenceTimerId = null; }
      const err = event?.error || "unknown";
      if (err === "no-speech") {
        // Not fatal — Chromium fires this on natural pauses. Don't
        // surface a visible error; let onend handle the auto-restart.
      } else if (err === "not-allowed" || err === "service-not-allowed") {
        setVoiceError("Microphone access is blocked — allow it in your browser settings.");
        expectedStopRef.current = true;
        setVoiceListening(false);
      } else if (err !== "aborted") {
        setVoiceError("Voice input stopped unexpectedly. Tap the mic to try again.");
        expectedStopRef.current = true;
        setVoiceListening(false);
      }
    };

    recognition.onend = () => {
      if (silenceTimerId) { clearTimeout(silenceTimerId); silenceTimerId = null; }
      if (expectedStopRef.current) {
        // User tapped stop OR our silence timer fired. Honour it.
        expectedStopRef.current = false;
        setVoiceListening(false);
        return;
      }
      // Unexpected end — Chromium stopped us. If the user is still in
      // "listening" mode, restart in 250ms. This is the bug fix for
      // the founder's "voice stops in the middle" report.
      // We can't read the latest voiceListening here without re-binding
      // the listener; instead, use a small trick: peek at the DOM
      // button's aria-pressed (set by us) to detect intent.
      try {
        const btn = document.querySelector('[data-testid="chat-voice-button"]');
        if (btn?.getAttribute("aria-pressed") === "true") {
          setTimeout(() => {
            try { recognition.start(); } catch { /* still in flight */ }
          }, 250);
        } else {
          setVoiceListening(false);
        }
      } catch {
        setVoiceListening(false);
      }
    };

    recognitionRef.current = recognition;
    return () => {
      if (silenceTimerId) clearTimeout(silenceTimerId);
      expectedStopRef.current = true;
      try { recognition.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    };
  }, [setInput]);

  const toggleVoice = () => {
    const r = recognitionRef.current;
    if (!r) return;
    if (voiceListening) {
      // Manual stop — set the expected flag so the onend path takes
      // the "user wanted to stop" branch and doesn't auto-restart.
      expectedStopRef.current = true;
      try { r.stop(); } catch { /* ignore */ }
      setVoiceListening(false);
    } else {
      setVoiceError("");
      expectedStopRef.current = false;
      try {
        r.start();
        setVoiceListening(true);
      } catch (e) {
        setVoiceError(e?.message || "Couldn't start voice input. Tap the mic to try again.");
        setVoiceListening(false);
      }
    }
  };

  const submit = () => {
    const text = input.trim();
    if (!text || sending) return;
    onSend(text);
    // Collapse the composer after send: blur + let the input clear.
    try { taRef.current?.blur(); } catch { /* ignore */ }
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Iteration 9+ — auto-grow textarea to actual content height.
  // We measure scrollHeight after every input change (layout effect)
  // and set the element's height explicitly, clamped between 36px
  // (1 line, idle) and ~200px (8 lines, max). Empty input → 1 row;
  // typing expands smoothly; clearing snaps back. The browser does the
  // wrap math, we just read its work.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    // Iteration 9+ — mirror the Today tab's composer exactly:
    //   - empty   → one slim row (40px)
    //   - typing  → grows with the content, up to a 200px ceiling
    //   - at max  → the textarea scrolls
    //   - send    → input clears, height snaps back to 40px
    if (!input) {
      el.style.height = "40px";
      return;
    }
    el.style.height = "auto";
    const next = Math.min(200, Math.max(40, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [input]);

  return (
    <div
      data-testid="chat-console"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative flex flex-col h-full min-h-0 bg-[var(--bg-primary)]"
    >
      {dragging && (
        <div
          data-testid="chat-drop-overlay"
          className="absolute inset-0 z-20 m-2 flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,var(--bg-primary))] pointer-events-none"
        >
          <span className="text-sm font-medium text-[var(--text-primary)]">
            Drop to attach it as a source
          </span>
        </div>
      )}
      {messages.length > 0 && (
        <div className="shrink-0 flex justify-end px-4 sm:px-6 pt-4">
          <button
            onClick={onClearChat}
            aria-label="Clear chat"
            className="min-h-11 flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            title="Clear chat"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear chat
          </button>
        </div>
      )}
      <div
        role="log"
        aria-live="polite"
        aria-label="Coaching conversation"
        tabIndex={0}
        className={`flex-1 min-h-0 ${messages.length ? "overflow-y-auto" : "overflow-hidden"} px-4 sm:px-6 py-6 space-y-6`}
      >
        {messages.length === 0 && (
          loading ? (
            <ChatLoadingSkeleton />
          ) : emptyPrompt ? (
            <div
              data-testid="chat-empty-simple"
              className="h-full flex flex-col justify-center max-w-lg"
            >
              <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                {emptyPrompt}
              </p>
            </div>
          ) : (
            <EmptyState scopeLabel={scopeLabel} scopeIntent={scopeIntent} />
          )
        )}
        {/* B5#8 — cap the rendered log; the full history stays in the
            parent's state, we just don't mount a thousand bubbles. */}
        {messages.length > CHAT_RENDER_CAP && (
          <div className="text-xs text-[var(--text-muted)]">
            Showing the last {CHAT_RENDER_CAP} messages.
          </div>
        )}
        {messages.slice(-CHAT_RENDER_CAP).map((m) => (
          <Message key={m.id} m={m} settled={settledId === m.id} onConfirm={onConfirm} onReject={onReject} onRefine={onRefine} onOpenRefine={onOpenRefine} onOpenReject={onOpenReject} onNavigate={onNavigate} onAnswerChoice={onAnswerChoice} showConfirm={showConfirm} busyProposal={busyProposal} onViewGoal={onViewGoal} />
        ))}
        {/* Clarification card lives at the END of the transcript, not below the
            composer: it is part of the coach's turn, so it scrolls with the
            reply and the composer stays pinned. Picking options no longer sends
            immediately — answers accumulate and go in one Submit. */}
        {pendingClarifications && pendingClarifications.questions?.length > 0 && (
          <div
            ref={clarificationRef}
            data-testid="clarification-chips"
            className="rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  data-testid="clarification-toggle"
                  onClick={() => setClarificationsCollapsed((v) => !v)}
                  aria-expanded={!clarificationsCollapsed}
                  aria-controls="clarification-body"
                  className="w-full rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
                      A few details
                    </span>
                    <span className="shrink-0 inline-flex items-center gap-1 font-mono text-[10px] tabular-nums uppercase tracking-wider text-[var(--text-muted)]">
                      {answeredCount} of {questionCount}
                      {clarificationsCollapsed
                        ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                        : <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />}
                    </span>
                  </span>
                  <span className="mt-1.5 block text-sm leading-relaxed text-[var(--text-primary)]">
                    {pendingClarifications.prompt || "I want to make a real proposal, but I need a couple of details first."}
                  </span>
                </button>

                {!clarificationsCollapsed && (
                  <div id="clarification-body" className="mt-3 space-y-3">
                    {showModeSelect && !autoAnswer && (
                      <p data-testid="auto-mode-escape-hint" className="text-[11px] leading-relaxed text-[var(--text-muted)]">
                        Answer what you can, then submit — or switch to Auto and I'll assume the rest.
                      </p>
                    )}

                    {pendingClarifications.questions.map((q, i) => {
                      const item = typeof q === "string" ? { question: q } : (q || {});
                      const opts = Array.isArray(item.options)
                        ? item.options.filter((o) => typeof o === "string" && o.trim())
                        : [];
                      const multi = item.multi === true;
                      return (
                        <div key={i} data-testid={`clarification-question-${i}`}>
                          <div className="flex items-baseline gap-2">
                            <span className="font-mono text-[10px] tabular-nums text-[var(--text-muted)]">{String(i + 1).padStart(2, "0")}</span>
                            <span className="text-sm font-medium leading-snug text-[var(--text-primary)]">{item.question}</span>
                            {multi && (
                              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Select all</span>
                            )}
                          </div>
                          {opts.length > 0 && (
                            <div
                              role={multi ? "group" : "radiogroup"}
                              aria-label={item.question}
                              className="mt-2 divide-y divide-[var(--border)] overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--bg-primary)]"
                            >
                              {opts.map((o, j) => {
                                const on = isPicked(i, o);
                                return (
                                  <button
                                    key={j}
                                    type="button"
                                    role={multi ? "checkbox" : "radio"}
                                    aria-checked={on}
                                    data-testid={`clarification-option-${i}-${j}`}
                                    onClick={() => togglePick(i, o, multi)}
                                    className={`flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)] ${
                                      on
                                        ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--text-primary)]"
                                        : "text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                                    }`}
                                  >
                                    <span className="min-w-0 flex-1 py-2.5">{o}</span>
                                    {on ? (
                                      <Check className="w-4 h-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
                                    ) : (
                                      <span
                                        aria-hidden="true"
                                        className={`h-4 w-4 shrink-0 border border-[var(--border-accent)] ${multi ? "rounded-[4px]" : "rounded-full"}`}
                                      />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          <div className="mt-2">
                            <input
                              type="text"
                              data-testid={`clarification-free-text-${i}`}
                              value={drafts[i] || ""}
                              onChange={(e) => setDraft(i, e.target.value)}
                              placeholder={opts.length > 0 ? "Add your own answer…" : "Type your answer…"}
                              aria-label={`Your own answer for question ${i + 1}`}
                              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-2 text-xs text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--border-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                            />
                            <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">
                              Pick one or more above (or none), then add your own here — everything is included.
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {(answerCount > 0 || !clarificationsCollapsed) && (
                  <button
                    type="button"
                    data-testid="clarification-submit"
                    onClick={submitClarifications}
                    disabled={!answerCount || sending}
                    className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-[var(--accent)] text-sm font-semibold text-[var(--bg-primary)] transition-opacity disabled:opacity-30 hover:opacity-90 active:scale-[0.99]"
                  >
                    <Send className="w-3.5 h-3.5" aria-hidden="true" />
                    {answerCount > 0 ? `Submit ${answerCount} answer${answerCount === 1 ? "" : "s"}` : "Submit"}
                  </button>
                )}
              </div>
              <button
                onClick={onDismissClarifications}
                data-testid="clarification-dismiss"
                title="Dismiss"
                aria-label="Dismiss suggestions"
                className="-mr-2 -mt-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 px-3 pt-2.5 pb-2 sm:px-4 sm:pt-3 sm:pb-2.5 bg-[var(--bg-primary)]"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
        {sources.length > 0 && (
          <div data-testid="attached-sources" className="mb-2 flex flex-wrap gap-1.5">
            {sources.map((s) => (
              <span key={s.id} className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                <FileText className="w-3 h-3" /> <span className="max-w-[140px] truncate">{s.original_filename}</span>
                <button onClick={() => onDeleteSource(s.id)} aria-label={`Remove source ${s.original_filename}`} className="min-h-11 min-w-11 inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--danger)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded"><X className="w-3 h-3" /></button>
              </span>
            ))}
          </div>
        )}
        {voiceSupported && voiceListening && (
          <SpeechWave text={input} />
        )}
        {showSources && linkOpen && (
          <form
            id="chat-link-row"
            data-testid="chat-link-form"
            onSubmit={(e) => {
              e.preventDefault();
              submitLink();
            }}
            className="mb-2 flex items-center gap-2 border border-[var(--border-accent)] bg-[var(--bg-secondary)] px-2.5 py-1.5"
          >
            <Link2 className="w-4 h-4 text-[var(--accent)] shrink-0" aria-hidden="true" />
            <input
              type="text"
              inputMode="url"
              data-testid="chat-link-input"
              value={linkValue}
              onChange={(e) => setLinkValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeLink();
                }
              }}
              placeholder="Paste a link — https://…"
              aria-label="Link to attach as a source"
              autoFocus
              className="flex-1 min-w-0 bg-transparent px-1 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none rounded"
            />
            <button
              type="submit"
              data-testid="chat-link-submit"
              disabled={!linkValue.trim()}
              className="min-h-11 px-3 rounded bg-[var(--accent)] text-[var(--bg-primary)] text-xs font-medium disabled:opacity-40 hover:opacity-90 transition-opacity shrink-0"
            >
              Attach
            </button>
            <button
              type="button"
              data-testid="chat-link-cancel"
              onClick={closeLink}
              aria-label="Cancel adding a link"
              className="min-h-11 min-w-11 inline-flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
        )}
        {/* Composer — Iteration 9+ final. The textarea + the action row
            below are ONE visual box: the wrapper owns the border and
            the focus highlight, the textarea has no outline of its own.
            Tapping it expands to a comfortable writing area; send /
            clear collapses it back to one slim row. */}
        <div className="border border-[var(--border)] focus-within:border-[var(--border-accent)] bg-[var(--bg-secondary)] transition-colors rounded-2xl">
          <textarea
            ref={taRef}
            data-testid="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder={voiceListening ? "Listening…" : "Think out loud…"}
            aria-label="Message the coach"
            // Auto-grow handled by the useLayoutEffect above: empty → one
            // slim 40px row (same as the Today tab), grows with content
            // to a 200px ceiling, then scrolls. Clears back to 40px on send.
            className={`block w-full bg-transparent resize-none ${input ? "overflow-y-auto" : "overflow-hidden"} px-3 py-2 text-sm leading-[22px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none border-0 transition-[height] duration-150 ease-out`}
            style={{ minHeight: "40px", maxHeight: "200px", height: "40px" }}
          />
          {/* Composer action row — Iteration 9+ final layout:
              - LEFT: Coach-mode dropdown in a flexible slot
                (`flex-1 min-w-0 max-w-[190px]`). It absorbs the
                available width and truncates a long label, so the
                icon group on the right NEVER reflows when the user
                switches modes.
              - RIGHT: paperclip / link / mic / send, grouped and
                `shrink-0`.
              Founder feedback: dropdown left, all four action icons
              right. */}
          <div className="flex items-center justify-between gap-2 px-1 py-1 border-t border-[var(--border)]">
            <div className="flex-1 min-w-0 max-w-[150px]">
              {/* Mode switcher (may ask / auto / grill) only where the chat
                  can actually change state. The general chat is read-only,
                  so it hides this. */}
              {showModeSelect && (
                <ChatModeSelect
                  autoAnswer={autoAnswer}
                  grillMe={grillMe}
                  setAutoAnswer={setAutoAnswer}
                  setGrillMe={setGrillMe}
                />
              )}
            </div>
            <div className="flex items-center gap-0 shrink-0">
              {showSources && (
                <>
                  <input ref={fileRef} type="file" hidden accept=".pdf,.md,.txt,.csv,.json,.png,.jpg,.jpeg" onChange={(e) => { if (e.target.files[0]) { onUploadFile(e.target.files[0]); e.target.value = ""; } }} />
                  <input ref={cameraRef} type="file" hidden accept="image/*" capture="environment" onChange={(e) => { if (e.target.files[0]) { onUploadFile(e.target.files[0]); e.target.value = ""; } }} />
                  <button data-testid="chat-attach-file" onClick={() => fileRef.current?.click()} title="Attach a file (PDF, .md, .txt…)" aria-label="Attach a file" className="h-11 w-9 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded">
                    <Paperclip className="w-4 h-4" />
                  </button>
                  <button data-testid="chat-attach-camera" onClick={() => cameraRef.current?.click()} title="Take a photo" aria-label="Take a photo" className="h-11 w-9 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded">
                    <Camera className="w-4 h-4" />
                  </button>
                  <button
                    data-testid="chat-attach-link"
                    onClick={() => setLinkOpen((v) => !v)}
                    aria-expanded={linkOpen}
                    aria-controls="chat-link-row"
                    title="Add a link as a source"
                    aria-label="Add a link as a source"
                    className={`h-11 w-9 flex items-center justify-center transition-colors shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded ${
                      linkOpen
                        ? "text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
                        : "text-[var(--text-muted)] hover:text-[var(--accent)]"
                    }`}
                  >
                    <Link2 className="w-4 h-4" />
                  </button>
                </>
              )}
              {voiceSupported && (
                <button
                  type="button"
                  data-testid="chat-voice-button"
                  onClick={toggleVoice}
                  title={voiceListening ? "Stop listening (or wait 60s for auto-pause)" : "Dictate with your voice"}
                  aria-label={voiceListening ? "Stop dictating" : "Dictate with your voice"}
                  aria-pressed={voiceListening}
                  className={`h-11 w-9 flex items-center justify-center transition-colors shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded ${
                    voiceListening
                      ? "bg-[var(--danger)] text-[var(--bg-primary)]"
                      : "text-[var(--text-muted)] hover:text-[var(--accent)]"
                  }`}
                >
                  {voiceListening ? <Square className="w-3.5 h-3.5" aria-hidden="true" /> : <Mic className="w-4 h-4" aria-hidden="true" />}
                </button>
              )}
              <button
                data-testid="chat-send-button"
                onClick={submit}
                disabled={sending || !input.trim()}
                aria-label="Send"
                className="h-11 w-11 ml-0.5 flex items-center justify-center bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-30 hover:opacity-90 transition-opacity shrink-0 rounded"
              >
                <ArrowUp className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        {/* Voice / coach state moves to a tiny floating status chip in
            the chat log's top-right when something is happening —
            otherwise nothing. */}
        {voiceError && (
          <p data-testid="voice-error" role="alert" className="mt-1 text-xs text-[var(--danger)]">
            {voiceError}
          </p>
        )}

      </div>
      <LinkPreviewDialog
        open={previewOpen}
        onClose={closePreview}
        url={previewUrl}
        onAttach={attachFromPreview}
        goalContext={goalContext}
      />
    </div>
  );
}
