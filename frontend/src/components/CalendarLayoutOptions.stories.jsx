import React from "react";

/**
 * Calendar layout options — 4 ways to show goal / commitment / task on a month
 * calendar, with the SAME mock week so they can be compared side by side.
 *
 * Pick one (A/B/C/D) and we implement it in Timeline's CalendarView.
 */

const INK = "#0B0B0C";

const GOALS = {
  g1: { title: "Switch to a new job in 3 months", color: "#0A84FF" },
  g2: { title: "Ship side-project MVP", color: "#34C759" },
};

// One week (Mon–Sun). Each day: commitments, tasks, milestones.
const WEEK = [
  {
    date: "Oct 5",
    items: [
      { kind: "task", goal: "g1", title: "SD framework review", hours: 2.1, commitment: "Block 15h/week in calendar", fulfils: "System design framework written" },
      { kind: "commitment", goal: "g1", title: "Draft target-role list" },
    ],
  },
  {
    date: "Oct 6",
    items: [
      { kind: "task", goal: "g1", title: "Tailor 3 applications", hours: 2.1, commitment: "Submit 3 tailored applications a day", fulfils: "20 tailored applications submitted" },
      { kind: "task", goal: "g2", title: "Ship landing page", hours: 1.5, commitment: "Ship the MVP checklist", fulfils: "MVP shipped" },
    ],
  },
  {
    date: "Oct 7",
    items: [{ kind: "commitment", goal: "g2", title: "Fix checkout bug" }],
  },
  {
    date: "Oct 8",
    items: [
      { kind: "milestone", goal: "g1", title: "20 tailored applications submitted" },
      { kind: "task", goal: "g1", title: "Mock interview #3", hours: 2.1, commitment: "Book 3 mock interviews", fulfils: "5 mocks passed" },
    ],
  },
  { date: "Oct 9", items: [] },
  { date: "Oct 10", items: [{ kind: "task", goal: "g2", title: "Write changelog", hours: 1.5, commitment: "Ship the MVP checklist", fulfils: "MVP shipped" }] },
  { date: "Oct 11", items: [] },
];

const KIND_GLYPH = { task: "●", commitment: "⚑", milestone: "◆" };

function CellShell({ children }) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <div className="grid grid-cols-7 gap-px rounded-lg overflow-hidden border border-[var(--border)] bg-[var(--border)]">
      {WEEK.map((d, i) => (
        <div key={d.date} className="min-h-[150px] bg-[var(--bg-primary)] p-1.5">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="font-mono text-[10px] text-[var(--text-muted)]">{days[i]}</span>
            <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">{d.date.split(" ")[1]}</span>
          </div>
          <div className="space-y-1">{children(d)}</div>
        </div>
      ))}
    </div>
  );
}

/* ── Option A — Goal-colored chips (Google Calendar style) ───────────────── */
function OptionA() {
  return (
    <CellShell>
      {(d) =>
        d.items.map((it, i) => {
          const g = GOALS[it.goal];
          const solid = it.kind !== "task";
          return (
            <div
              key={i}
              className="truncate rounded px-1.5 py-0.5 text-[11px] leading-tight"
              style={
                solid
                  ? { background: g.color, color: INK }
                  : { background: `color-mix(in srgb, ${g.color} 22%, transparent)`, color: "var(--text-primary)", borderLeft: `3px solid ${g.color}` }
              }
              title={`${g.title} · ${it.title}`}
            >
              {it.kind === "commitment" ? "⚑ " : it.kind === "milestone" ? "◆ " : ""}
              {it.title}
            </div>
          );
        })
      }
    </CellShell>
  );
}

/* ── Option B — Nested tree: Goal ▸ Commitment/Milestone ▸ Task ─────────── */
function OptionB() {
  return (
    <CellShell>
      {(d) => {
        const byGoal = {};
        d.items.forEach((it) => { (byGoal[it.goal] ||= []).push(it); });
        return Object.entries(byGoal).map(([gid, items]) => (
          <div key={gid} className="space-y-0.5">
            <div className="truncate text-[10px] font-semibold" style={{ color: GOALS[gid].color }}>
              {GOALS[gid].title}
            </div>
            {items.map((it, i) => (
              <div key={i} className="truncate pl-2 text-[11px] leading-tight text-[var(--text-secondary)]">
                <span style={{ color: GOALS[gid].color }}>{it.kind === "task" ? "└ " : "├ "}</span>
                {it.kind === "commitment" ? "⚑ " : it.kind === "milestone" ? "◆ " : ""}
                {it.title}
              </div>
            ))}
          </div>
        ));
      }}
    </CellShell>
  );
}

/* ── Option C — Two-line breadcrumb card (+ commitment) ───────────────────── */
function OptionC() {
  return (
    <CellShell>
      {(d) =>
        d.items.map((it, i) => {
          const g = GOALS[it.goal];
          return (
            <div key={i} className="rounded px-1.5 py-1" style={{ borderLeft: `3px solid ${g.color}`, background: `color-mix(in srgb, ${g.color} 13%, var(--bg-primary))` }}>
              <div className="truncate text-[11px] leading-tight text-[var(--text-primary)]">
                {it.kind === "commitment" ? "⚑ " : it.kind === "milestone" ? "◆ " : "○ "}
                {it.title}
              </div>
              {it.commitment && (
                <div className="truncate text-[9px] leading-tight text-[var(--text-secondary)]">
                  ⚑ {it.commitment}
                </div>
              )}
              <div className="truncate text-[9px] leading-tight text-[var(--text-muted)]">
                {g.title}
                {it.fulfils ? ` › fulfils ${it.fulfils}` : ""}
                {it.hours ? ` · ${it.hours}h` : ""}
              </div>
            </div>
          );
        })
      }
    </CellShell>
  );
}

/* ── Option D — Grouped by commitment it advances ────────────────────────── */
function OptionD() {
  return (
    <CellShell>
      {(d) => {
        const byFulfil = {};
        d.items.forEach((it) => { const k = it.fulfils || it.title; (byFulfil[k] ||= []).push(it); });
        return Object.entries(byFulfil).map(([k, items]) => {
          const lead = items[0];
          const g = GOALS[lead.goal];
          return (
            <div key={k} className="rounded border border-[var(--border)] p-1">
              <div className="truncate text-[10px] font-semibold text-[var(--text-primary)]">
                {lead.kind === "commitment" ? "⚑ " : lead.kind === "milestone" ? "◆ " : "◎ "}
                {lead.title}
              </div>
              {items.filter((it) => it.kind === "task").map((it, i) => (
                <div key={i} className="truncate pl-2 text-[10px] text-[var(--text-secondary)]">
                  {KIND_GLYPH.task} {it.title}
                  <span className="text-[var(--text-muted)]"> · {g.title}</span>
                </div>
              ))}
            </div>
          );
        });
      }}
    </CellShell>
  );
}

function Frame({ label, desc, children }) {
  return (
    <div className="space-y-2 p-4 bg-[var(--bg-primary)]">
      <div>
        <div className="text-sm font-semibold text-[var(--text-primary)]">{label}</div>
        <div className="text-xs text-[var(--text-muted)]">{desc}</div>
      </div>
      {children}
    </div>
  );
}

export default {
  title: "Timeline/Calendar layout options",
  parameters: { layout: "fullscreen" },
};

export const Option_A_GoalColoredChips = () => (
  <Frame
    label="Option A — Goal-coloured chips"
    desc="Google-Calendar style. One chip per item, colour = goal. Compact; hierarchy via colour + strike/flag glyphs."
  >
    <OptionA />
  </Frame>
);

export const Option_B_NestedTree = () => (
  <Frame
    label="Option B — Nested tree (goal › item › task)"
    desc="Each day groups items under the goal name. Clearest hierarchy; uses more vertical space."
  >
    <OptionB />
  </Frame>
);

export const Option_C_BreadcrumbCard = () => (
  <Frame
    label="Option C — Breadcrumb card (with commitment)"
    desc="Line 1 = task/commitment; line 2 = the commitment it advances; line 3 = 'Goal › fulfils milestone · hours'. Left colour stripe per goal."
  >
    <OptionC />
  </Frame>
);

export const Option_D_GroupedByCommitment = () => (
  <Frame
    label="Option D — Grouped by commitment it advances"
    desc="Emphasises 'this task achieves this commitment/milestone of this goal'. Tasks nest under the item they fulfil."
  >
    <OptionD />
  </Frame>
);
