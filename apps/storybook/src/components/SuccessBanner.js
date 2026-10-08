import { CheckCircle2, ArrowRight } from "lucide-react";

/**
 * SuccessBanner — inline confirmation divider appended to the message
 * stream after a proposal is confirmed (operation-scoped context model,
 * spec §10.5).
 *
 * It lives IN the messages[] array as `role: "success"` — the visible
 * stream is never cleared on confirm; this banner is the visual divider
 * between one conversation bucket and the next.
 */
export default function SuccessBanner({ message, goalId, goalTitle, createdAt, onView }) {
  const time = createdAt
    ? new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  return (
    <div
      data-testid="success-banner"
      className="my-3 rounded-lg border border-[var(--accent)]/30 bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-[var(--accent)]" />
          <span className="font-medium text-[var(--text-primary)]">{message}</span>
          {time && <span className="text-xs text-[var(--text-muted)] font-mono">{time}</span>}
        </div>
        {goalId && onView && (
          <button
            type="button"
            onClick={onView}
            data-testid="success-banner-view"
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 text-xs font-mono uppercase tracking-wider text-[var(--accent)] hover:text-[var(--text-primary)] transition-colors"
          >
            view <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="mt-2 text-xs text-[var(--text-muted)]">
        Keep chatting to add another, or close when you're done.
      </div>
    </div>
  );
}
