import { useMemo, useState } from "react";
import { CalendarRange, ChevronDown, Layers, Target } from "lucide-react";

/**
 * PlanBreakdown — the multi-horizon execution dashboard panel.
 *
 * Renders a goal's persisted `plan_items` lattice (written by the proposal
 * executor on confirm) as a single coherent trajectory across all five
 * horizons:
 *
 *   Yearly   → the goal span
 *   Quarterly→ phase spans (each keeps its 20% timeline buffer)
 *   Monthly  → milestones (dated by the scheduler inside each phase)
 *   Weekly   → derived checkpoints covering each phase's effective window
 *   Daily    → the smallest next actions (commitments)
 *
 * Pure presentational: reads `state.plan_items` / `state.goals`, no writes.
 * Styling uses the ui-ux contract tokens (--bg-secondary, --border, …).
 */

function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function range(start, end) {
  if (!start && !end) return "";
  if (!end || end === start) return fmt(start);
  return `${fmt(start)} – ${fmt(end)}`;
}

const HORIZON_LABEL = {
  yearly: "Year",
  quarterly: "Quarter",
  monthly: "Month",
  weekly: "Week",
  daily: "Day",
};

const HORIZON_ORDER = ["daily", "weekly", "monthly", "quarterly", "yearly"];
const HORIZON_DOT = {
  daily: "bg-[var(--accent)]",
  weekly: "bg-[var(--accent)]",
  monthly: "bg-[color-mix(in_srgb,var(--accent)_40%,transparent)]",
  quarterly: "bg-[color-mix(in_srgb,var(--accent)_25%,transparent)]",
  yearly: "bg-[var(--danger)]",
};

function GroupRow({ item }) {
  const when =
    item.horizon === "daily" || item.horizon === "monthly"
      ? range(item.due_date)
      : item.horizon === "yearly"
      ? range(item.start_date, item.end_date)
      : range(item.start_date, item.end_date);
  return (
    <li className="flex items-baseline gap-2 py-1">
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full shrink-0 translate-y-[-1px] ${HORIZON_DOT[item.horizon]}`}
      />
      <span className="text-[12px] text-[var(--text-primary)] leading-snug min-w-0 flex-1">
        {item.title}
        {item.note && item.horizon === "quarterly" ? (
          <span className="text-[var(--text-secondary)]"> — {item.note}</span>
        ) : null}
      </span>
      <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0 tabular-nums">
        {when}
      </span>
    </li>
  );
}

function GoalPlan({ goal, items }) {
  const [open, setOpen] = useState(true);
  const weeklyHours = items.find((i) => i.horizon === "yearly")?.weekly_hours;

  const grouped = useMemo(() => {
    const buckets = new Map();
    for (const it of items) {
      const list = buckets.get(it.horizon) ?? [];
      list.push(it);
      buckets.set(it.horizon, list);
    }
    return buckets;
  }, [items]);

  return (
    <section className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span
            aria-hidden="true"
            className="w-6 h-6 rounded flex items-center justify-center bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]"
          >
            <Target className="w-3.5 h-3.5" />
          </span>
          <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
            {goal?.title ?? "Plan"}
          </span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {weeklyHours ? (
            <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
              {weeklyHours}h/wk
            </span>
          ) : null}
          <ChevronDown
            className={`w-3.5 h-3.5 text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-3">
          {HORIZON_ORDER.filter((h) => (grouped.get(h) || []).length > 0).map((h) => (
            <div key={h}>
              <h4 className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)] mb-1">
                <Layers className="w-3 h-3" aria-hidden="true" />
                {HORIZON_LABEL[h]}
              </h4>
              <ul>
                {(grouped.get(h) || []).map((it) => (
                  <GroupRow key={`${h}-${it.id}`} item={it} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function PlanBreakdown({ state }) {
  const planItems = state?.plan_items;
  const goals = state?.goals;

  const byGoal = useMemo(() => {
    const map = new Map();
    if (!planItems) return map;
    for (const it of planItems) {
      if (!it.goal_id) continue;
      const list = map.get(it.goal_id) ?? [];
      list.push(it);
      map.set(it.goal_id, list);
    }
    return map;
  }, [planItems]);

  const page = useMemo(() => {
    const index = new Map();
    if (goals) {
      for (const g of goals) index.set(g.id, g);
    }
    const out = [];
    for (const [goalId, items] of byGoal.entries()) {
      const goal = index.get(goalId);
      // A dropped goal's plan is dead — don't render it.
      if (goal && goal.status === "dropped") continue;
      out.push({ goal, items });
    }
    return out;
  }, [byGoal, goals]);

  if (page.length === 0) return null;

  return (
    <div data-testid="plan-breakdown" className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        <CalendarRange className="w-3.5 h-3.5" aria-hidden="true" />
        Plan breakdown
      </h3>
      {page.map(({ goal, items }) => (
        <GoalPlan key={goal?.id ?? "unknown"} goal={goal} items={items} />
      ))}
    </div>
  );
}