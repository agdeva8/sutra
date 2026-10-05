import React from "react";
import { TimelineItemDetailsDialog } from "./Timeline";

/**
 * Item details — the hierarchy is Task → Milestone → Goal (each with its
 * date). No phases, no commitment middle-layer.
 */

const iso = (offset) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const state = {
  goals: [
    {
      id: "g1",
      title: "Switch into platform engineering",
      status: "active",
      target_date: iso(80),
      why: "You want to change employer within a 3-month window.",
      next_action: "Draft a one-page target list of 15 roles and a master resume.",
    },
  ],
  milestones: [
    { id: "m1", goal_id: "g1", title: "Target list of 15 roles and master resume finalized", target_date: iso(6) },
    { id: "m2", goal_id: "g1", title: "3 STAR stories and 1 system design walkthrough recorded", target_date: iso(20) },
  ],
};

const task = {
  kind: "task",
  id: "t1",
  title: "Target list of 15 roles and master resume finalized",
  note: "Fulfils Target list of 15 roles and master resume finalized · 2.1h",
  date: new Date(),
  goal_id: "g1",
  status: "open",
};

const milestoneItem = {
  kind: "milestone",
  id: "m1",
  title: "3 STAR stories and 1 system design walkthrough recorded",
  target_date: iso(20),
  goal_id: "g1",
  status: "open",
};

const blockerItem = {
  kind: "blocker",
  id: "b1",
  title: "Conference week",
  // The component reads Date objects (as allItems provides) — not the raw
  // start_date/end_date strings.
  start: new Date(`${iso(3)}T00:00:00`),
  end: new Date(`${iso(7)}T00:00:00`),
  note: "Out of office — no deep work possible.",
};

export default {
  title: "Components/Timeline item details",
  parameters: { layout: "fullscreen" },
};

const Frame = (props) => (
  <div className="min-h-[560px] bg-[var(--bg-primary)]">
    <TimelineItemDetailsDialog state={state} onClose={() => {}} onEdit={() => {}} onToggle={() => {}} onRemove={() => {}} {...props} />
  </div>
);

export const Task = () => <Frame item={task} />;
export const Milestone = () => <Frame item={milestoneItem} />;
export const Blocker = () => <Frame item={blockerItem} />;
