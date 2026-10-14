import { Sparkles } from "lucide-react";

/**
 * OverCommitmentIndicator — the week's load read, as a single card.
 *
 * Extracted out of TrackingDashboard, which was the only other thing that
 * rendered it: Overview carries the tracker pair (this + TrackerCard) and
 * the Goal tab it used to be shared with is gone, so the component lives on
 * its own rather than in a file that no longer exists.
 *
 * `oc` is `state.over_commitment` — null on a state that has never been
 * computed, and then this renders nothing rather than an empty box.
 */
const LEVEL_STYLES = {
  clear: { color: "var(--success)", label: "on track" },
  moderate: { color: "var(--accent)", label: "keep an eye on it" },
  high: { color: "var(--warning)", label: "stretched" },
  critical: { color: "var(--danger)", label: "too much on" },
};

export default function OverCommitmentIndicator({ oc }) {
  if (!oc) return null;
  const style = LEVEL_STYLES[oc.level] || LEVEL_STYLES.clear;
  return (
    <div
      data-testid="over-commitment-indicator"
      role="status"
      className="border p-4 rounded-md"
      style={{ borderColor: style.color, background: "color-mix(in srgb, " + style.color + " 8%, transparent)" }}
    >
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4" style={{ color: style.color }} />
        <span className="text-xs font-semibold" style={{ color: style.color }}>Your week · {style.label}</span>
        <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">
          {oc.active_goals} {oc.active_goals === 1 ? "goal" : "goals"}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-[var(--text-primary)]">{oc.message}</p>
      {oc.conflicting?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {oc.conflicting.map((c) => (
            <span key={c} className="font-mono text-[10px] px-1.5 py-0.5 border rounded" style={{ borderColor: style.color, color: style.color }}>{c}</span>
          ))}
        </div>
      )}
    </div>
  );
}
