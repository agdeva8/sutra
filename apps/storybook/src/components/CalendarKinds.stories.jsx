import React from "react";
import { CalendarCard } from "./CalendarCards";
import {
  KIND_STYLE,
  goalColor,
  reminderColor,
  recurringColor,
} from "../constants/calendarKinds";

/**
 * Every kind of thing on the calendar, side by side: goal work (the reference style), reminders,
 * repeating commitments, fixed commitments, milestones and time away. Goals, reminders and series each
 * get one stable colour from their id, so two reminders differ and one reminder matches itself every day.
 */

const card = (id, kind, title, color, extra = {}) => ({
  id,
  item: { id, kind, title },
  glyph: KIND_STYLE[kind].glyph,
  look: KIND_STYLE[kind].look,
  title,
  color,
  ...extra,
});

const ROWS = [
  ["Goal work", [
    card("g1-a", "session", "09:00 Leetcode: graphs", goalColor("goal_switch_jobs"), { goalTitle: "Switch jobs" }),
    card("g2-a", "task", "Draft chapter 2", goalColor("goal_write_book"), { goalTitle: "Write a book" }),
  ]],
  ["Reminders", [
    card("r1-a", "reminder", "13:00 Take meds", reminderColor("rem_94f387c5ab")),
    card("r1-b", "reminder", "13:00 Take meds", reminderColor("rem_94f387c5ab")),
    card("r2-a", "reminder", "09:00 Call mom", reminderColor("rem_6df79dfdcd")),
  ]],
  ["Repeating", [
    card("s1-a", "recurring", "18:00 Guitar class", recurringColor("rec_guitar")),
    card("s1-b", "recurring", "18:00 Guitar class", recurringColor("rec_guitar")),
    card("s2-a", "recurring", "07:00 Gym", recurringColor("rec_gym")),
  ]],
  ["Other kinds", [
    card("f1", "fixed", "10:00 Standup", KIND_STYLE.fixed.color),
    card("m1", "milestone", "Mock interview passed", goalColor("goal_switch_jobs"), { goalTitle: "Switch jobs" }),
    card("b1", "blocker", "Away: Goa trip", KIND_STYLE.blocker.color),
  ]],
];

function KindsBoard() {
  return (
    <div className="space-y-4 p-4" style={{ maxWidth: 420 }}>
      {ROWS.map(([label, cards]) => (
        <section key={label} className="space-y-1.5">
          <h3 className="text-xs font-semibold text-[var(--text-muted)]">{label}</h3>
          {cards.map((c) => (
            <CalendarCard key={c.id} card={c} />
          ))}
        </section>
      ))}
    </div>
  );
}

export default {
  title: "Components/CalendarKinds",
  component: KindsBoard,
  parameters: { layout: "fullscreen" },
};

export const AllKinds = {};
