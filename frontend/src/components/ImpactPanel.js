import { AlertTriangle, GitBranch, Calendar, ArrowRight } from "lucide-react";

/**
 * ImpactPanel — renders the structured `[[IMPACT]]` block the server
 * emits alongside assistant replies (spec §10.5): over-commitment load
 * shift, conflicts with existing plan items, buffer warnings, and the
 * coach's recommendation.
 *
 * Attached to an assistant message as `message.impact`; renders null
 * when absent so it drops into any message loop safely.
 */
export default function ImpactPanel({ impact }) {
  if (!impact) return null;
  const { over_commitment, conflicts = [], buffer_warning, recommendation } = impact;

  return (
    <div
      data-testid="impact-panel"
      className="mt-3 rounded-lg border border-[var(--border-accent)] bg-[var(--bg-secondary)] p-3 text-sm"
    >
      <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2">
        How this changes your plan
      </div>

      {over_commitment && (
        <div className="flex items-start gap-2 mb-2">
          <GitBranch className="w-4 h-4 mt-0.5 text-[var(--accent)]" />
          <div>
            <div className="font-medium">
              Load: {over_commitment.from} → {over_commitment.to}
            </div>
            <div className="text-[var(--text-secondary)]">{over_commitment.reason}</div>
          </div>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="flex items-start gap-2 mb-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-[var(--warning)]" />
          <div className="flex-1">
            {conflicts.map((c, i) => (
              <div key={i} className="text-[var(--text-secondary)]">
                <span className="font-medium">{c.with}</span>: {c.detail}
              </div>
            ))}
          </div>
        </div>
      )}

      {buffer_warning && (
        <div className="flex items-start gap-2 mb-2">
          <Calendar className="w-4 h-4 mt-0.5 text-[var(--warning)]" />
          <div className="text-[var(--text-secondary)]">{buffer_warning}</div>
        </div>
      )}

      {recommendation && (
        <div className="flex items-start gap-2 mt-2 pt-2 border-t border-[var(--border)]">
          <ArrowRight className="w-4 h-4 mt-0.5 text-[var(--accent)]" />
          <div className="text-[var(--text-primary)]">{recommendation}</div>
        </div>
      )}
    </div>
  );
}
