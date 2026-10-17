import React from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import BlockCard from "./BlockCard";

/**
 * Every way a block of the four-kind model reads on the board: goal colour vs grey, tick vs no tick,
 * stripes, flag chips, repeat/alert badges, and the task states. Colour says who it belongs to; the
 * glyph and texture say what it is — so a block is still readable when two colours sit close.
 */

const card = (id, block_kind, title, extra = {}) => ({ id, block_kind, title, ...extra });

const ROWS = [
  ["Event (no goal — grey, nothing to tick)", [
    card("e1", "event", "Dinner with Mohit", { day: "2026-10-17", start: "19:00", end: "21:00" }),
    card("e2", "event", "Standup", { day: "2026-10-17", start: "09:30", end: "09:45", repeat: { weekdays: [0, 2, 4] } }),
  ]],
  ["Event with a goal (colour follows the goal)", [
    card("e3", "event", "Interview at Google", { day: "2026-10-17", start: "11:00", end: "12:00", goal_id: "goal_switch_jobs", alert_before: 30 }),
  ]],
  ["Task (tick on the left)", [
    card("t1", "task", "Buy milk", { day: "2026-10-17", state: "open" }),
    card("t2", "task", "Call mom", { day: "2026-10-17", at: "18:00", state: "open" }),
    card("t3", "task", "Leetcode: graphs", { day: "2026-10-17", start: "16:00", end: "18:00", goal_id: "goal_switch_jobs", state: "open" }),
    card("t4", "task", "Draft chapter 2", { day: "2026-10-17", goal_id: "goal_write_book", state: "done" }),
    card("t5", "task", "Did half the graph set", { day: "2026-10-17", goal_id: "goal_switch_jobs", state: "partial" }),
    card("t6", "task", "Skipped the mock", { day: "2026-10-17", goal_id: "goal_switch_jobs", state: "skip" }),
  ]],
  ["Away (hatched — never goal work)", [
    card("a1", "away", "Goa trip", { start_date: "2026-10-17", end_date: "2026-10-18" }),
  ]],
  ["Milestone (flag chip — open, reached, overdue)", [
    card("m1", "milestone", "Mock interview passed", { goal_id: "goal_switch_jobs", target_date: "2026-10-17" }),
    card("m2", "milestone", "Resume rewrite", { goal_id: "goal_switch_jobs", target_date: "2026-10-17", reached: true }),
    card("m3", "milestone", "Portfolio site live", { goal_id: "goal_write_book", target_date: "2026-10-01" }),
  ]],
];

function CardsBoard() {
  return (
    <div className="space-y-4 p-4" style={{ maxWidth: 420 }}>
      {ROWS.map(([label, blocks]) => (
        <section key={label} className="space-y-1.5">
          <h3 className="text-xs font-semibold text-[var(--text-muted)]">{label}</h3>
          {blocks.map((b) => (
            <BlockCard key={b.id} block={b} goalTitle={b.goal_id ? (b.goal_id === "goal_switch_jobs" ? "Switch jobs" : "Write a book") : undefined} onClick={() => {}} onToggleDone={() => {}} />
          ))}
        </section>
      ))}
    </div>
  );
}

export default {
  title: "Timeline/Block card (4 kinds)",
  component: CardsBoard,
  parameters: { layout: "fullscreen" },
};

export const AllKinds = { render: () => <CardsBoard /> };

export const RowDensity = {
  render: () => (
    <div className="space-y-2 p-4" style={{ maxWidth: 420 }}>
      <BlockCard density="row" block={card("t1", "task", "Buy milk", { day: "2026-10-17", state: "open" })} onClick={() => {}} onToggleDone={() => {}} />
      <BlockCard density="row" block={card("t3", "task", "Leetcode: graphs", { day: "2026-10-17", start: "16:00", end: "18:00", goal_id: "goal_switch_jobs", state: "open" })} goalTitle="Switch jobs" onClick={() => {}} onToggleDone={() => {}} />
    </div>
  ),
};

/** The checkbox is the quick path: one tap toggles done without opening the sheet. */
export const TicksDone = {
  render: () => {
    const [done, setDone] = React.useState(false);
    return (
      <div className="p-4" style={{ maxWidth: 420 }}>
        <BlockCard block={{ ...card("t1", "task", "Buy milk", { day: "2026-10-17" }), state: done ? "done" : "open", done }} onToggleDone={() => setDone((d) => !d)} onClick={() => {}} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("checkbox"));
    await expect(canvas.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
    await expect(canvas.getByText("Buy milk")).toHaveClass(/line-through/);
  },
};
