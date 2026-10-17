import React, { useState } from "react";
import { Plus } from "lucide-react";
import { expect, fn, userEvent, within } from "storybook/test";
import BlockCard from "./BlockCard";
import BlockDetailSheet from "./BlockDetailSheet";
import BlockFormDialog from "./BlockFormDialog";

/**
 * The four block kinds end to end, in-memory: add, edit, delete, tick, attach a goal. The board is
 * a day view — all-day strip on top (away bands, milestone flags, untimed things), hour grid below.
 * Tapping empty grid space adds a block prefilled with that hour; tapping a block opens its sheet.
 * This is the UX contract the real DayPlanner will host once /blocks is wired in.
 */

const GOALS = [
  { id: "goal_switch_jobs", title: "Switch jobs" },
  { id: "goal_write_book", title: "Write a book" },
];

const TODAY = "2026-10-17";

const SEED = [
  { block_kind: "away", id: "block_away1", title: "Goa trip", start_date: "2026-10-17", end_date: "2026-10-18" },
  { block_kind: "milestone", id: "block_ms1", title: "Mock interview passed", goal_id: "goal_switch_jobs", target_date: TODAY, parent_id: null, hours: 0, reached: false },
  { block_kind: "task", id: "block_t1", title: "Buy milk", day: TODAY, start: null, end: null, at: null, effort_hours: null, goal_id: null, milestone_id: null, repeat: null, alert_before: null, done: false, state: "open", description: "", why: "" },
  { block_kind: "task", id: "block_t2", title: "Call mom", day: TODAY, start: null, end: null, at: "18:00", effort_hours: null, goal_id: null, milestone_id: null, repeat: null, alert_before: 0, done: false, state: "open", description: "", why: "" },
  { block_kind: "event", id: "block_e1", title: "Standup", day: TODAY, start: "09:30", end: "09:45", repeat: { weekdays: [0, 2, 4] }, alert_before: null, goal_id: null, note: "" },
  { block_kind: "event", id: "block_e2", title: "Interview at Google", day: TODAY, start: "11:00", end: "12:00", repeat: null, alert_before: 30, goal_id: "goal_switch_jobs", note: "" },
  { block_kind: "task", id: "block_t3", title: "Leetcode: graphs", day: TODAY, start: "16:00", end: "18:00", at: null, effort_hours: 2, goal_id: "goal_switch_jobs", milestone_id: null, repeat: null, alert_before: null, done: false, state: "open", description: "", why: "" },
];

const HOURS = Array.from({ length: 16 }, (_, i) => i + 7); // 07:00–22:00

function DemoBoard() {
  const [blocks, setBlocks] = useState(SEED);
  const [detail, setDetail] = useState(null); // the block id open in the sheet
  const [form, setForm] = useState(null);     // { editing, defaultStart, defaultEnd, defaultKind }
  const goalTitle = (id) => (GOALS.find((g) => g.id === id) || {}).title;

  const openBlock = blocks.find((b) => b.id === detail) || null;
  const replace = (next) => setBlocks((prev) => prev.map((b) => (b.id === next.id ? next : b)));
  const strip = (b) => b.block_kind === "away" || b.block_kind === "milestone" || (b.block_kind === "event" && !(b.start && b.end)) || (b.block_kind === "task" && !(b.start && b.end));
  const timed = (b) => (b.start && b.end) || (b.block_kind === "task" && b.at);

  return (
    <div className="mx-auto min-h-[640px] w-full max-w-[420px] bg-[var(--bg-primary)]">
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Fri, Oct 17</h2>
        <button type="button" data-testid="board-add" onClick={() => setForm({ defaultKind: "event", defaultStart: "09:00", defaultEnd: "10:00" })}
          className="flex h-10 items-center gap-1 rounded-full bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--bg-primary)]">
          <Plus className="h-4 w-4" aria-hidden="true" /> Add
        </button>
      </header>

      {/* All-day strip: away bands, milestone flags, untimed tasks and all-day events. */}
      <section className="border-y border-[var(--border)] px-2 py-1.5" aria-label="All day">
        <div className="flex flex-wrap gap-1">
          {blocks.filter(strip).map((b) => (
            <div key={b.id} className="w-full">
              <BlockCard block={b} goalTitle={goalTitle(b.goal_id)} onClick={() => setDetail(b.id)}
                onToggleDone={() => replace({ ...b, done: !b.done, state: b.done ? "open" : "done" })} />
            </div>
          ))}
        </div>
      </section>

      {/* Hour grid. Tap an empty hour to add a block there. */}
      <section aria-label="Hour grid">
        {HOURS.map((h) => {
          const hour = `${String(h).padStart(2, "0")}:00`;
          const here = blocks.filter((b) => b.start && b.start.slice(0, 2) === String(h).padStart(2, "0"));
          return (
            <div key={h} className="flex min-h-14 items-stretch border-b border-[var(--border)]">
              <div className="w-12 shrink-0 pt-1 pr-1 text-right font-mono text-[10px] text-[var(--text-muted)]">{hour}</div>
              <button type="button" aria-label={`Add at ${hour}`} data-testid={`slot-${hour}`}
                onClick={() => setForm({ defaultKind: "event", defaultStart: hour, defaultEnd: `${String(Math.min(23, h + 1)).padStart(2, "0")}:00` })}
                className="flex-1 space-y-1 p-1 text-left hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]">
                {here.map((b) => (
                  <BlockCard key={b.id} block={b} goalTitle={goalTitle(b.goal_id)} onClick={() => setDetail(b.id)}
                    onToggleDone={() => replace({ ...b, done: !b.done, state: b.done ? "open" : "done" })} />
                ))}
              </button>
            </div>
          );
        })}
      </section>

      {openBlock && (
        <BlockDetailSheet
          block={openBlock}
          goalTitle={goalTitle(openBlock.goal_id)}
          goals={GOALS}
          onClose={() => setDetail(null)}
          onEdit={(b) => { setDetail(null); setForm({ editing: b }); }}
          onDelete={(b) => { setBlocks((prev) => prev.filter((x) => x.id !== b.id)); setDetail(null); }}
          onUpdate={(next) => replace(next)}
          onOpenGoal={() => setDetail(null)}
        />
      )}
      <BlockFormDialog
        open={!!form}
        editing={form?.editing || null}
        goals={GOALS}
        defaultKind={form?.defaultKind || "event"}
        defaultStart={form?.defaultStart}
        defaultEnd={form?.defaultEnd}
        defaultDate={TODAY}
        onClose={() => setForm(null)}
        onSave={(block) => {
          setBlocks((prev) => (form?.editing ? prev.map((b) => (b.id === block.id ? block : b)) : [...prev, { ...block, id: `block_new_${prev.length}` }]));
          setForm(null);
        }}
      />
    </div>
  );
}

export default {
  title: "Timeline/Blocks (4 kinds)",
  component: DemoBoard,
  parameters: { layout: "fullscreen" },
};

/** The whole board: every kind, every flow, live. */
export const Interactive = { render: () => <DemoBoard /> };

/** Add flow: the form for an Event with the kind picker open. */
export const AddForm = {
  render: () => (
    <div className="min-h-[540px] bg-[var(--bg-primary)]">
      <BlockFormDialog open goals={GOALS} defaultKind="event" defaultDate={TODAY} onClose={() => {}} onSave={() => {}} />
    </div>
  ),
};

/** The sheet as a Milestone opens it: Mark reached first, Open goal second. */
export const MilestoneDetail = {
  render: () => (
    <div className="min-h-[540px] bg-[var(--bg-primary)]">
      <BlockDetailSheet
        block={{ block_kind: "milestone", id: "block_ms1", title: "Mock interview passed", goal_id: "goal_switch_jobs", target_date: TODAY, parent_id: null, hours: 0, reached: false }}
        goalTitle="Switch jobs"
        goals={GOALS}
        onClose={() => {}}
        onUpdate={() => {}}
      />
    </div>
  ),
};

/** The sheet as a Task opens it: the three tick states live here. */
export const TaskDetail = {
  render: () => (
    <div className="min-h-[540px] bg-[var(--bg-primary)]">
      <BlockDetailSheet
        block={{ block_kind: "task", id: "block_t2", title: "Call mom", day: TODAY, start: null, end: null, at: "18:00", effort_hours: null, goal_id: null, milestone_id: null, repeat: null, alert_before: 0, done: false, state: "open", description: "", why: "" }}
        goals={GOALS}
        onClose={() => {}}
        onUpdate={() => {}}
      />
    </div>
  ),
};

// Interaction tests: the three flows the UX exists for — add, tick, delete.
export const AddEventFlow = {
  render: () => <DemoBoard />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId("board-add"));
    await userEvent.type(canvas.getByTestId("block-title"), "Dinner with Mohit");
    await userEvent.click(canvas.getByTestId("block-form-submit"));
    await expect(canvas.getByText("Dinner with Mohit")).toBeInTheDocument();
  },
};

export const TickTaskFlow = {
  render: () => <DemoBoard />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByTestId("block-card-block_t3");
    await userEvent.click(within(card).getByRole("checkbox"));
    await expect(within(canvas.getByTestId("block-card-block_t3")).getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
  },
};

export const DeleteEventFlow = {
  render: () => <DemoBoard />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId("block-card-block_e1"));
    await userEvent.click(canvas.getByTestId("block-delete"));
    await userEvent.click(canvas.getByTestId("block-delete-confirm"));
    await expect(canvas.queryByTestId("block-card-block_e1")).not.toBeInTheDocument();
  },
};
