import { useState, useRef, useLayoutEffect } from "react";
import { CalendarDays, MessageSquare, Send, Sparkles } from "lucide-react";
import { localDateKey } from "../lib/utils";
import TodayTimetable from "./TodayTimetable";

/**
 * Today — the "Today" tab. Hosts:
 *   1. A greeting strip with the date + the section's CTA row (which used
 *      to live on the TrackerCard and is now duplicated here so the tab
 *      stands on its own).
 *   2. The dated items list (TodayTimetable rendered with `fullTimetable=true`).
 *   3. **ONE** section-level free-text input at the bottom — "Tell the
 *      coach anything about today" — that opens the chat with whatever
 *      the user typed. Per-item note + per-item chat input were
 *      removed from TodayTimetable in Iteration 7; this is the single
 *      place the user talks about the day as a whole.
 *
 * The bottom card stays collapsed if the user has nothing on today so
 * the empty state doesn't end with a half-empty input that looks
 * broken.
 */
export default function Today({ state, onChange, onOpenChat }) {
  const [text, setText] = useState("");

  const handleSend = (e) => {
    e?.preventDefault?.();
    const trimmed = text.trim();
    if (!trimmed) return;
    // Scoped to the day: the modal titles itself "About: Today (…)" and
    // carries kind/title to the server, so the coach knows this is about
    // today's plan rather than a free-for-all. The user's OWN text is
    // passed through — only canned prompts were dropped from scoped opens.
    onOpenChat?.(trimmed, {
      scope: "generic",
      kind: "plan_day",
      title: `Today (${localDateKey()})`,
      helperText: "Tell me anything about today — I'll fold it into the plan.",
    });
    setText("");
  };

  return (
    <div data-testid="today-view" className="px-4 sm:px-6 py-5 sm:py-6 space-y-5 max-w-[820px] mx-auto w-full">
      <header className="space-y-1">
        <div className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <CalendarDays className="w-3 h-3 text-[var(--accent)]" aria-hidden="true" />
          <span>Today, {localDateKey()}</span>
        </div>
        <h2 className="font-display text-2xl sm:text-3xl font-semibold text-[var(--text-primary)] tracking-tight">
          What's on the docket?
        </h2>
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
          Tick items as you finish them, or ask the coach to renegotiate / break one down. When you want to talk about the day as a whole, use the box at the bottom — that goes straight to the chat.
        </p>
      </header>

      <TodayTimetable
        state={state}
        onChange={onChange}
        onOpenChat={onOpenChat}
        compact={false}
        fullTimetable={true}
      />

      <SectionChatInput
        text={text}
        setText={setText}
        onSubmit={handleSend}
      />
    </div>
  );
}

/**
 * SectionChatInput — the single "tell the coach about today" input.
 * Lives below the timetable list so the user has one place to dump a
 * thought, ask a question, or kick off a planning conversation. Empty
 * when there are no items so the empty Today tab doesn't end with a
 * stranded half-filled input.
 */
function SectionChatInput({ text, setText, onSubmit }) {
  const taRef = useRef(null);

  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    // Iteration 9+ — the textarea is a slim single row while empty; the
    // long placeholder must not be measured into the height (Chrome
    // includes a wrapped placeholder in scrollHeight). Only grow once
    // the user has actually typed, up to the max-h-28 cap.
    if (!text) {
      el.style.height = "40px";
      return;
    }
    el.style.height = "auto";
    const next = Math.min(112, Math.max(40, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [text]);
  return (
    <form
      onSubmit={onSubmit}
      data-testid="today-section-chat"
      className="rounded-2xl bg-[var(--bg-secondary)] p-4 space-y-2"
    >
      <label
        htmlFor="today-section-chat-input"
        className="font-medium inline-flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]"
      >
        <Sparkles className="w-3.5 h-3.5 text-[var(--accent)]" aria-hidden="true" />
        Tell the coach anything about today
      </label>
      <div className="flex items-start gap-2">
        <textarea
          ref={taRef}
          id="today-section-chat-input"
          data-testid="today-section-chat-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              onSubmit(e);
            }
          }}
          rows={1}
          placeholder="Something about today…"
          aria-label="Tell the coach anything about today"
          className="flex-1 min-w-0 bg-[var(--bg-primary)] border border-[var(--border)] rounded-xl px-3 py-2 text-[14px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] resize-none overflow-y-auto"
          style={{ minHeight: "40px", maxHeight: "112px", height: "40px" }}
        />
        <button
          type="submit"
          disabled={!text.trim()}
          aria-label="Send to coach"
          className="h-11 px-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] text-[var(--bg-primary)] text-[14px] font-semibold hover:opacity-90 disabled:opacity-30 transition-opacity shrink-0"
        >
          <Send className="w-4 h-4" aria-hidden="true" />
          Send
        </button>
      </div>
      <p className="hidden sm:inline-flex text-[11px] text-[var(--text-muted)] items-center gap-1">
        <MessageSquare className="w-3 h-3" aria-hidden="true" />
        ⌘/Ctrl + Enter to send
      </p>
    </form>
  );
}
