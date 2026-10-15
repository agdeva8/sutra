import { progressStatus } from "../constants/goalProgress";

/**
 * GoalProgress — where one goal stands: how much of the plan is finished against how much should be by
 * now, the model's verdict on it, and a track of its milestones (o—o—o) coloured by how each is going.
 *
 * Every number is the server's (computed by code); the status word and the notes are the model's. With
 * no verdict yet the numbers still show, so the card is useful before the judgement arrives.
 */
const shortDate = (iso) => {
  const d = iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`) : null;
  return d && !isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
};

export default function GoalProgress({ progress }) {
  if (!progress || !progress.total_planned) return null;
  const verdict = progress.verdict;
  const status = progressStatus(verdict?.status);
  const byMilestone = Object.fromEntries((verdict?.milestones || []).map((m) => [m.id, m]));
  const milestones = progress.milestones || [];

  return (
    <div data-testid={`goal-progress-${progress.goal_id}`} className="mt-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-mono tabular-nums text-[var(--text-secondary)]">
          {progress.pct_done}% done · {progress.pct_expected}% expected by now
        </span>
        {status.label && (
          <span
            data-testid="goal-progress-status"
            className="rounded-full px-2 py-0.5 font-semibold"
            style={{ color: status.color, background: `color-mix(in srgb, ${status.color} 14%, transparent)` }}
          >
            {status.label}
          </span>
        )}
      </div>

      {/* The bar: finished so far, with a tick where the plan says we should be. */}
      <div
        role="progressbar"
        aria-valuenow={progress.pct_done}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Plan finished"
        className="relative h-2 rounded-full bg-[var(--bg-tertiary)]"
      >
        <div className="h-full rounded-full" style={{ width: `${progress.pct_done}%`, background: status.color === "var(--text-muted)" ? "var(--accent)" : status.color }} />
        <span
          aria-hidden="true"
          className="absolute -top-0.5 h-3 w-0.5 rounded bg-[var(--text-primary)] opacity-60"
          style={{ left: `${Math.min(progress.pct_expected, 100)}%` }}
        />
      </div>

      {verdict?.note && <p className="text-[12px] leading-snug text-[var(--text-secondary)]">{verdict.note}</p>}

      {milestones.length > 0 && (
        <ol aria-label="Milestones" className="flex items-start pt-1">
          {milestones.map((m, i) => {
            const v = byMilestone[m.id];
            const color = m.done ? "var(--success)" : progressStatus(v?.status).color;
            return (
              <li key={m.id} className="flex min-w-0 flex-1 flex-col items-center" title={[m.title, shortDate(m.target), v?.note].filter(Boolean).join(" · ")}>
                <div className="flex w-full items-center">
                  <span className={`h-px flex-1 ${i === 0 ? "opacity-0" : ""} bg-[var(--border)]`} aria-hidden="true" />
                  <span
                    data-testid="goal-progress-milestone"
                    className="h-3 w-3 shrink-0 rounded-full border-2"
                    style={{ borderColor: color, background: m.done ? color : "transparent" }}
                  />
                  <span className={`h-px flex-1 ${i === milestones.length - 1 ? "opacity-0" : ""} bg-[var(--border)]`} aria-hidden="true" />
                </div>
                <span className="mt-1 w-full truncate px-1 text-center text-[10px] text-[var(--text-muted)]">{shortDate(m.target)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
