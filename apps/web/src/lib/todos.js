/**
 * To-do list helpers shared by the Todos and Today screens: ticking (which never removes anything), and
 * the sorts and filters the Todos list offers.
 */
import { api } from "./api";
import { isTodo } from "./events";
import { TODO_PRIORITY_BY_KEY, TODO_PRIORITY_NORMAL } from "../constants/calendarKinds";

const STATUS_DONE = "done";
const STATUS_OPEN = "open";

/** True for a `calendar_blocks` row: it ticks through `/blocks`, not through `plan_items`. */
const isBlock = (item) => !!item?.block_kind;

/**
 * Tick a plan item or a calendar block done or open, and patch the board in place so the row stays
 * where it is, struck through. A to-do goes through `PATCH /todos/:id` (the gateway); a goal's task
 * through `/plan-items`; a 4-kind task block through `PATCH /blocks/:id`.
 */
export async function toggleDone(item, onChange) {
  const next = item.state === STATUS_DONE || item.status === STATUS_DONE ? STATUS_OPEN : STATUS_DONE;
  if (isBlock(item)) {
    await api.blocks.update(item.id, { done: next === STATUS_DONE, state: next });
    onChange?.((prev) => ({
      ...prev,
      blocks: (prev.blocks || []).map((b) =>
        b.id === item.id ? { ...b, done: next === STATUS_DONE, state: next } : b,
      ),
    }));
    return;
  }
  if (isTodo(item)) await api.editTodo(item.id, { done: next === STATUS_DONE });
  else await api.updatePlanItem(item.id, { status: next });
  onChange?.((prev) => ({
    ...prev,
    plan_items: (prev.plan_items || []).map((p) => (p.id === item.id ? { ...p, status: next } : p)),
  }));
}

const quotaCount = (block, day) => Number(block?.quota_done?.[day] || 0);

/** The count `day` of a quota would hold after `delta`, kept between 0 and the quota. */
export function quotaAfter(block, day, delta) {
  const limit = typeof block?.quota === "number" ? block.quota : Infinity;
  return Math.min(limit, Math.max(0, quotaCount(block, day) + delta));
}

/** The `quota_done` map with `day` stepped by `delta`, a key for every day already counted. */
export function quotaDoneAfter(block, day, delta) {
  return { ...(block?.quota_done || {}), [day]: quotaAfter(block, day, delta) };
}

/**
 * Step one day of a quota by ±1 through `PATCH /blocks/:id`, and patch the board in place so the
 * day's N/M moves at once. Days are counted separately: one day's +1 leaves every other day alone,
 * and a day reads as done when its count reaches the quota.
 */
export async function adjustQuota(block, day, delta, onChange) {
  if (!block?.id || !day) return;
  const next = quotaDoneAfter(block, day, delta);
  if (next[day] === quotaCount(block, day)) return; // already at 0 or at the quota
  await api.blocks.update(block.id, { quota_done: next });
  onChange?.((prev) => ({
    ...prev,
    blocks: (prev.blocks || []).map((b) => (b.id === block.id ? { ...b, quota_done: next } : b)),
  }));
}

/** Put a saved row into the board in place (new rows first), so a save never waits on a re-read. */
export const upsertPlanItem = (row) => (prev) => {
  const items = prev.plan_items || [];
  const exists = items.some((p) => p.id === row.id);
  return { ...prev, plan_items: exists ? items.map((p) => (p.id === row.id ? row : p)) : [row, ...items] };
};

/** Put a saved block into the board in place (new rows first), for a to-do saved as a `TaskBlock`. */
export const upsertBlock = (block) => (prev) => {
  const blocks = prev.blocks || [];
  const exists = blocks.some((b) => b.id === block.id);
  return { ...prev, blocks: exists ? blocks.map((b) => (b.id === block.id ? block : b)) : [block, ...blocks] };
};

/**
 * A to-do `TaskBlock` in the shape the to-do list sorts and renders (the legacy `plan_item` fields).
 * `block_kind` and `state` stay on it, so the same row still ticks through `PATCH /blocks/:id`.
 */
export const blockToTodo = (block) => ({
  ...block,
  due_date: block.day || null,
  due_time: block.at ? String(block.at).slice(0, 5) : null,
  status: block.done || block.state === STATUS_DONE ? STATUS_DONE : STATUS_OPEN,
  item_type: "todo",
  note: block.description || "",
});

const FAR_FUTURE = "9999-12-31";
const priorityRank = (p) => (TODO_PRIORITY_BY_KEY[p.priority] || TODO_PRIORITY_BY_KEY[TODO_PRIORITY_NORMAL]).rank;
const dueKey = (p) => `${p.due_date || FAR_FUTURE}T${p.due_time || "99:99"}`;

export const TODO_SORTS = [
  { key: "due", label: "Due date", compare: (a, b) => dueKey(a).localeCompare(dueKey(b)) || priorityRank(a) - priorityRank(b) },
  { key: "priority", label: "Priority", compare: (a, b) => priorityRank(a) - priorityRank(b) || dueKey(a).localeCompare(dueKey(b)) },
  { key: "created", label: "Newest", compare: (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) },
];

export const TODO_FILTERS = [
  { key: "all", label: "All", test: () => true },
  { key: "open", label: "Not done", test: (p) => p.status !== STATUS_DONE },
  { key: "dated", label: "Has a day", test: (p) => !!p.due_date },
  { key: "goal", label: "For a goal", test: (p) => !!p.goal_id },
];

/**
 * The to-dos on the board, filtered and sorted, with not-done on top and done sunk to the bottom.
 *
 * A to-do now lives in `state.blocks` (`TaskBlock` with `todo: true`); the `plan_items` rows are the
 * ones filed before the move, plus the backfill's copies. The backfill kept ids, so the two lists
 * are deduplicated by id — the `plan_items` row wins, because `PATCH /todos/:id` still edits it.
 */
export function listTodos(planItems, { blocks = [], sort = TODO_SORTS[0].key, filter = TODO_FILTERS[0].key } = {}) {
  const cmp = (TODO_SORTS.find((s) => s.key === sort) || TODO_SORTS[0]).compare;
  const test = (TODO_FILTERS.find((f) => f.key === filter) || TODO_FILTERS[0]).test;
  const legacy = (planItems || []).filter(isTodo);
  const legacyIds = new Set(legacy.map((p) => p.id));
  const fromBlocks = (blocks || [])
    .filter((b) => b.block_kind === "task" && b.todo && !legacyIds.has(b.id))
    .map(blockToTodo);
  return [...fromBlocks, ...legacy]
    .filter(test)
    .sort((a, b) => (a.status === STATUS_DONE) - (b.status === STATUS_DONE) || cmp(a, b));
}
