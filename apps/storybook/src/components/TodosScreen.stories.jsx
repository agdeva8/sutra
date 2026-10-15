import React, { useState } from "react";
import TodosScreen from "./TodosScreen";
import { localDateKey } from "../lib/utils";

/** The To-dos tab: not-done on top, done sunk and struck through, sort and filter chips. Phone width. */

const key = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateKey(d);
};

const STATE = {
  goals: [{ id: "goal_switch_jobs", title: "Switch jobs in 3 months", status: "active" }],
  plan_items: [
    { id: "a", item_type: "todo", horizon: "daily", title: "Reply to Mohit", priority: "high", status: "open", created_at: "2026-10-15T08:00:00Z" },
    { id: "b", item_type: "todo", horizon: "daily", title: "Buy milk", priority: "normal", due_date: key(1), status: "open", created_at: "2026-10-15T09:00:00Z" },
    { id: "c", item_type: "todo", horizon: "daily", title: "Update resume headline", priority: "normal", due_date: key(3), due_time: "18:00", goal_id: "goal_switch_jobs", description: "Lead with platform work", status: "open", created_at: "2026-10-14T09:00:00Z" },
    { id: "d", item_type: "todo", horizon: "daily", title: "Return library books", priority: "low", due_date: key(-2), status: "open", created_at: "2026-10-12T09:00:00Z" },
    { id: "e", item_type: "todo", horizon: "daily", title: "Pay rent", priority: "high", due_date: key(0), status: "done", created_at: "2026-10-13T09:00:00Z" },
    { id: "f", horizon: "daily", title: "A goal's own task (not listed here)", goal_id: "goal_switch_jobs", due_date: key(0), status: "open" },
  ],
};

function Harness() {
  const [state, setState] = useState(STATE);
  const onChange = (fn) => typeof fn === "function" && setState(fn);
  return (
    <div className="mx-auto max-w-[420px]">
      <TodosScreen state={state} onChange={onChange} />
    </div>
  );
}

export default { title: "Components/TodosScreen", component: Harness, parameters: { layout: "fullscreen" } };

export const Default = {};
