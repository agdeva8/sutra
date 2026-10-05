import { ArrowRight, Compass } from "lucide-react";

/**
 * NavigateCard — renders a read-only "Take me there" suggestion.
 *
 * The general chat ("Chat with your coach") never applies edits itself.
 * When the coach detects the user wants to change something, it emits a
 * `navigate` proposal instead: `{ action: "navigate", target, label }`.
 * This card turns that into a single button that closes the chat and
 * opens the right surface (Add Goal, Goals, Today, Timeline, …). The
 * actual change happens there.
 *
 * `onNavigate(target)` is supplied by the parent page, which owns the
 * routing/registration for each destination.
 */

const DEFAULT_LABELS = {
  add_goal: "Add a goal",
  drop_goal: "Go to your goals",
  pause_goal: "Go to your goals",
  edit_goal: "Go to your goals",
  today: "Go to Today",
  timeline: "Go to Timeline",
  sources: "Go to Sources",
  memories: "Go to Memories",
  motivation: "Explore ideas",
};

export default function NavigateCard({ proposal, onNavigate, busy }) {
  const d = proposal?.args || {};
  const target = typeof d.target === "string" ? d.target : "";
  if (!target) return null;
  const label =
    (typeof d.label === "string" && d.label.trim()) ||
    DEFAULT_LABELS[target] ||
    "Take me there";

  return (
    <div
      data-testid="navigate-card"
      data-target={target}
      className="border border-[var(--accent)] rounded-2xl overflow-hidden bg-[var(--tool-bg)] my-3"
    >
      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center gap-2">
        <Compass className="w-3.5 h-3.5 text-[var(--accent)]" aria-hidden="true" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent)] font-medium">
          Next step
        </span>
      </div>
      <div className="px-3 py-3">
        <button
          type="button"
          data-testid={`navigate-${target}`}
          onClick={() => onNavigate?.(target)}
          disabled={busy}
          className="w-full h-11 rounded-xl inline-flex items-center justify-center gap-2 text-sm font-semibold bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-40 hover:opacity-90 active:scale-[0.99] transition-opacity"
        >
          {label}
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Changes happen on that screen — not in this chat.
        </p>
      </div>
    </div>
  );
}
