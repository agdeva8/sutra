import { useState } from "react";
import { HelpCircle, Check, Send } from "lucide-react";

/**
 * AskCard — renders a coach "ask" proposal as tappable choices.
 *
 * The coach emits `{ action: "ask", question, options: [...], multi }`
 * whenever it needs the user to pick a direction (pause vs drop, which
 * goal, which date, …). This card turns those options into buttons so
 * the user taps instead of typing:
 *   - single-select: tapping an option sends it immediately.
 *   - multi-select (`multi: true`): tap to toggle, then Send the set.
 *
 * The free-text composer is always still available for a custom answer.
 * `onAnswer(text)` is supplied by the parent, which funnels it into the
 * chat's normal `send`.
 */
export default function AskCard({ proposal, onAnswer, busy }) {
  const d = proposal?.args || {};
  const question = d.question || d.text || d.title || "";
  const options = Array.isArray(d.options)
    ? d.options.map((o) => (typeof o === "string" ? o.trim() : "")).filter(Boolean)
    : [];
  const multi = d.multi === true;

  const [selected, setSelected] = useState([]);
  const [answered, setAnswered] = useState(false);

  // No options → the prose already carries the question; render nothing.
  if (options.length === 0) return null;

  const tap = (opt) => {
    if (answered || busy) return;
    if (!multi) {
      setAnswered(true);
      onAnswer?.(opt);
      return;
    }
    setSelected((prev) =>
      prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt],
    );
  };

  const submitMulti = () => {
    if (!selected.length || answered || busy) return;
    setAnswered(true);
    onAnswer?.(selected.join(", "));
  };

  return (
    <div
      data-testid="ask-card"
      className="border border-[var(--accent)] rounded-2xl overflow-hidden bg-[var(--tool-bg)] my-3"
    >
      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
        <HelpCircle className="w-3.5 h-3.5 text-[var(--accent)]" aria-hidden="true" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent)] font-medium">
          {multi ? "Pick any" : "Pick one"}
        </span>
        {answered && (
          <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
            answered
          </span>
        )}
      </div>
      <div className="px-3 py-3 space-y-2">
        {question && (
          <p className="text-sm leading-relaxed text-[var(--text-primary)]">{question}</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {options.map((opt, i) => {
            const on = selected.includes(opt);
            return (
              <button
                key={i}
                type="button"
                data-testid={`ask-option-${i}`}
                disabled={busy || answered}
                onClick={() => tap(opt)}
                aria-pressed={multi ? on : undefined}
                className={`min-h-11 inline-flex items-center gap-1.5 text-left text-sm px-3 py-2 rounded-full border transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                  on
                    ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--bg-primary)]"
                    : "border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                }`}
              >
                {multi && on && <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                {opt}
              </button>
            );
          })}
        </div>
        {multi && (
          <button
            type="button"
            data-testid="ask-send"
            disabled={!selected.length || busy || answered}
            onClick={submitMulti}
            className="mt-1 w-full h-11 rounded-xl inline-flex items-center justify-center gap-2 text-sm font-semibold bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-40 hover:opacity-90 active:scale-[0.99] transition-opacity"
          >
            <Send className="w-3.5 h-3.5" aria-hidden="true" /> Send ({selected.length})
          </button>
        )}
      </div>
    </div>
  );
}
