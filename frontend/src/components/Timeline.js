import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CalendarClock,
  AlertOctagon,
  Circle,
  CheckCircle2,
  ListTree,
  LayoutGrid,
  Layers,
  Milestone as MilestoneIcon,
  Flag,
  Activity,
  Target,
  Clock,
  Inbox,
  Sparkles,
  ChevronDown,
  Plus,
  Pencil,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import DayPlanner from "./DayPlanner";
import CenteredDialog from "./CenteredDialog";
import { CardsGrid, WeekdayHeader, TargetGrid, WeekGrid, MonthGrid } from "./CalendarCards";
import { HourGrid } from "./CalendarHourGrid";
import { api } from "../lib/api";
import { toast } from "sonner";
import useMediaQuery from "../hooks/useMediaQuery";

/* ---------------------------------------------------------------------------
 * Sutra Timeline — 3-view dropdown: Day by day (Drill), At a glance (Strip),
 * Calendar (multi-day spanning tiles).
 *
 * Replaces the prior Chart (Gantt) / Drill toggle. The Gantt `ChartView`,
 * `ListView`, and chart-only header controls are gone; the dropdown is the
 * single way to switch views.
 *
 * Props: { state, onPrefill, onOpenChatWith, onOpenChat }.
 *   onPrefill      — generic opener, accepts a prefill string only.
 *   onOpenChatWith — preferred opener, accepts (prefill, scope) so the
 *                    chat modal can thread `scope/refId/kind/title/
 *                    helperText` into the new conversation.
 *   onOpenChat     — legacy alias for onPrefill (string-only), kept so
 *                    older call sites still work.
 * ------------------------------------------------------------------------ */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_SHORT = ["M", "T", "W", "T", "F", "S", "S"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* Horizon → color token. weekly + medium share `--accent`. */
const HORIZON_COLOR = {
  weekly: "var(--accent)",
  short: "var(--warning)",
  medium: "var(--accent)",
  long: "var(--success)",
};
const HORIZON_LABEL = { weekly: "WK", short: "SHORT", medium: "MED", long: "LONG" };

/** Per-goal stripe colours for the calendar cards (deterministic by goal id). */
const GOAL_PALETTE = ["#0A84FF", "#34C759", "#FF9F0A", "#BF5AF2", "#FF375F", "#5AC8FA"];

/* Status → color token. Issue 2/3 (Iteration 5) — tile color is now
   driven by status, not horizon, so on-track / overdue / in-progress /
   not-started reads at a glance. Goal tiles still fall back to
   HORIZON_COLOR when no status is set (goal is a container, not a
   deliverable). */
const STATUS_COLOR = {
  done: "var(--success)",       // green — on-track / completed
  active: "var(--success)",     // green — on-track
  on_track: "var(--success)",   // green — alias
  overdue: "var(--danger)",     // red — past due / not done
  blocked: "var(--danger)",     // red — blocked
  in_progress: "var(--warning)",// yellow — medium / partial
  open: "var(--warning)",       // yellow — open / partial
  paused: "var(--text-muted)",  // grey — paused
  not_started: "var(--text-muted)", // grey
  dropped: "var(--text-muted)", // grey
};
function statusColor(item) {
  if (!item) return "var(--text-muted)";
  const s = (item.status || "").toLowerCase();
  if (s && STATUS_COLOR[s]) return STATUS_COLOR[s];
  // Goals without status → use horizon. Items without status → warning.
  if (item.kind === "goal" && item.horizon && HORIZON_COLOR[item.horizon]) {
    return HORIZON_COLOR[item.horizon];
  }
  return "var(--warning)";
}

/* ---------------------------------------------------------------------------
 * Bar treatment — long spans vs single days.
 *
 * The 3-months and Year views were painting *every* item as an opaque
 * fill of `statusColor()`. A goal with no target_date gets a 90-day
 * window from its horizon, so it painted a full-width `--success` block
 * that repeated in all 13 week rows — the view became a wall of flat
 * pastel green, and a quarter-long goal carried the same visual weight
 * as a one-day commitment. The data hierarchy was completely flat.
 *
 * Gantt convention fixes this, and it is what these two views now do:
 *
 *   long run  → tinted body (the hue at low alpha over the card) plus a
 *               saturated leading edge. The body says "this runs", the
 *               edge says "and its status is this".
 *   short run → the solid, higher-emphasis fill, unchanged.
 *
 * The tint is deliberately *below* the 3:1 data-mark threshold against
 * the card (1.3–1.4:1) because it is a surface, not the mark. The 3:1
 * data contrast is carried by the leading edge, which is the full
 * semantic hue (4.5–8.5:1 against every surface in both themes).
 *
 * `surface` is the card the bar is painted on — the 3-months rows sit
 * on --bg-primary, the Year plot on --bg-secondary — so the tint is
 * always mixed against what is actually behind it.
 * ------------------------------------------------------------------------- */

const SPAN_TINT_PCT = 18;      // hue share in the tinted body
const SPAN_SOLID_MAX_DAYS = 2; // ≤2 days still reads as "one thing, one day"

/* Length of an item in days, 1 for a single-day point. */
function spanDays(item) {
  if (!item) return 1;
  const s = item.start || item.date;
  const e = item.end || item.date;
  if (!s || !e) return 1;
  const a = startOfDay(s);
  const b = startOfDay(e);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 1;
  return Math.max(1, Math.round((b - a) / DAY_MS) + 1);
}

/* Returns the paint recipe for one calendar bar. `stripePx` is the width
 * of the leading edge; 0 means the solid single-day treatment. */
function barPaint(item, surface, stripePx = 3) {
  const hue = statusColor(item);
  if (spanDays(item) <= SPAN_SOLID_MAX_DAYS) {
    return {
      background: hue,
      stripe: null,
      // Amber/green fills need dark ink (white fails contrast); blue/red keep
      // the theme-inverse. `--on-warning` stays dark in both themes.
      color:
        hue.includes("warning") || hue.includes("success")
          ? "var(--on-warning)"
          : "var(--bg-primary)",
    };
  }
  return {
    background: `color-mix(in srgb, ${hue} ${SPAN_TINT_PCT}%, ${surface})`,
    stripe: hue,
    color: "var(--text-primary)", // label sits on a near-card tint
    boxShadow: `inset ${stripePx}px 0 0 0 ${hue}`,
  };
}

/* Scoped-chat context for a calendar item. Centralised because the same
   scope/kind/helperText map was duplicated across CalendarTile,
   CalendarDayItem and the quarter bars — the year view needs it too, and
   one source of truth keeps the chat modal titles consistent. */
const SCOPE_MAP = {
  goal: { scope: "goal", kind: "edit_goal" },
  milestone: { scope: "milestone", kind: "edit_goal" },
  commitment: { scope: "commitment", kind: "plan_day" },
  blocker: { scope: "blocker", kind: "plan_day" },
  task: { scope: "goal", kind: "edit_goal" },
};
const SCOPE_HELPER = {
  goal: "Tell the coach what should change in this goal.",
  milestone: "Tell the coach what should change about this milestone.",
  commitment: "What's the next step on this commitment?",
  blocker: "What's the smallest unblock?",
};
function scopeForItem(item) {
  const m = SCOPE_MAP[item?.kind];
  if (!m) return null;
  const goalTitle = item.goalTitle || item.goal_title;
  const date = item.target_date || item.due || (item.date instanceof Date ? fmtIso(item.date) : "");
  const detail = [
    goalTitle ? `Goal: ${goalTitle}.` : "",
    item.phase ? `Phase: ${item.phase}.` : "",
    item.note ? `${item.note}.` : "",
    date ? `Date: ${date}.` : "",
    item.start_date && item.end_date ? `Blocker window: ${item.start_date}–${item.end_date}.` : "",
  ].filter(Boolean).join(" ");
  return {
    scope: m.scope,
    kind: m.kind,
    // A task is scoped to its GOAL (the chat edits the goal/plan), not the
    // task row itself.
    refId: item.kind === "task" ? item.goalId || item.goal_id || item.id : item.id,
    title: item.title,
    helperText: [SCOPE_HELPER[item.kind], detail].filter(Boolean).join(" "),
  };
}

/* View-type dropdown options — plain-language labels for the general public. */
const VIEW_TYPES = [
  {
    key: "drill",
    label: "Day by day",
    sub: "see what's due each day",
    Icon: ListTree,
  },
  {
    key: "strip",
    label: "At a glance",
    sub: "snapshots for today, this week, this month…",
    Icon: Layers,
  },
  {
    key: "calendar",
    label: "Calendar",
    sub: "see tasks across the days they span",
    Icon: LayoutGrid,
  },
];

/* Calendar span presets — Google-Calendar style. */
const CAL_SPANS = [
  { key: "day", label: "Day", days: 1 },
  { key: "week", label: "Week", days: 7 },
  { key: "month", label: "Month", days: 30 },
  { key: "quarter", label: "3 Months", days: 90 },
  { key: "year", label: "Year", days: 365 },
];

/* Strip-view horizons. */
const HORIZONS = [
  { key: "today", label: "Today", sub: "Due now", maxDays: 0 },
  { key: "thisWeek", label: "This Week", sub: "Next 7 days", maxDays: 7 },
  { key: "thisMonth", label: "This Month", sub: "Next 30 days", maxDays: 30 },
  { key: "thisQuarter", label: "This Quarter", sub: "Next 90 days", maxDays: 90 },
  { key: "thisYear", label: "This Year", sub: "Next 12 months", maxDays: 365 },
  { key: "later", label: "Later", sub: "Beyond a year", maxDays: Infinity },
];

const DAY_MS = 86400000;

/* ------------------------------- date helpers ----------------------------- */

const parse = (s) => {
  if (!s) return null;
  const d = new Date(s + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();
const fmtDay = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const fmtIso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtMonth = (d) => `${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const startOfWeek = (d) => {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const daysUntil = (d, today) => {
  if (!d) return null;
  return Math.round((startOfDay(d).getTime() - today.getTime()) / DAY_MS);
};

/* ---------------------------------------------------------------------------
 * Goal span — a goal is a container that runs for weeks or months, so it
 * must read as a bar that crosses days, never a single-day dot.
 *
 * Coach-drafted goals frequently land with `start_date` AND `target_date`
 * both null. When that happens the old code fell back to
 * `date = today` for both ends, so every goal collapsed onto one cell and
 * the calendar looked like a pile of unrelated one-day blocks (the exact
 * symptom reported: "all goals show as if they are only for 1 day").
 *
 * Instead we derive a window from the goal's own horizon, which is the
 * field the coach already uses to express "how big is this". The window is
 * anchored to whichever real date we do have, and falls back to today so
 * an undated goal is still visible in the current view.
 * ------------------------------------------------------------------------- */
const HORIZON_SPAN_DAYS = { weekly: 7, short: 30, medium: 90, long: 365 };
const DEFAULT_SPAN_DAYS = 90;

function goalWindow(goal, today) {
  const explicitStart = parse(goal.start_date) || parse(goal.created_at);
  const explicitEnd = parse(goal.target_date);
  const span = HORIZON_SPAN_DAYS[goal.horizon] ?? DEFAULT_SPAN_DAYS;

  // Both dates real → trust them verbatim.
  if (explicitStart && explicitEnd) {
    return { start: explicitStart, end: explicitEnd, inferred: false };
  }
  // Only a target → the window runs the horizon's length *up to* it.
  if (explicitEnd) {
    return { start: addDays(explicitEnd, -(span - 1)), end: explicitEnd, inferred: true };
  }
  // Only a start → the window runs the horizon's length *from* it.
  if (explicitStart) {
    return { start: explicitStart, end: addDays(explicitStart, span - 1), inferred: true };
  }
  // Neither → run the window from today so the goal is on screen now.
  return { start: today, end: addDays(today, span - 1), inferred: true };
}

/* ------------------------------ drill buckets ----------------------------- */

function makeBuckets(level, anchor) {
  const y = anchor.getFullYear();
  if (level === "year") {
    return [0, 1, 2, 3].map((q) => ({
      start: new Date(y, q * 3, 1),
      end: new Date(y, q * 3 + 3, 1),
      label: `Q${q + 1}`,
      sub: `${MONTHS[q * 3]}–${MONTHS[q * 3 + 2]} ${y}`,
      next: "quarter",
    }));
  }
  if (level === "quarter") {
    const qm = anchor.getMonth();
    return [0, 1, 2].map((i) => ({
      start: new Date(y, qm + i, 1),
      end: new Date(y, qm + i + 1, 1),
      label: MONTHS[qm + i],
      sub: `${y}`,
      next: "month",
    }));
  }
  if (level === "month") {
    const m = anchor.getMonth();
    const res = [];
    let ws = startOfWeek(new Date(y, m, 1));
    const monthEnd = new Date(y, m + 1, 1);
    while (ws < monthEnd) {
      const we = new Date(ws);
      we.setDate(we.getDate() + 7);
      const lastDay = new Date(we.getTime() - DAY_MS);
      res.push({
        start: new Date(ws),
        end: new Date(we),
        label: `${fmtDay(ws)} – ${fmtDay(lastDay)}`,
        sub: "",
        next: "week",
      });
      ws = we;
    }
    return res;
  }
  const ws = startOfWeek(anchor);
  return [...Array(7)].map((_, i) => {
    const ds = new Date(ws);
    ds.setDate(ds.getDate() + i);
    const de = new Date(ds);
    de.setDate(de.getDate() + 1);
    return { start: ds, end: de, label: DOW[i], sub: fmtDay(ds), next: null };
  });
}

/* ============================================================================
 * Timeline — root component.
 * ========================================================================= */

export default function Timeline({ state, onPrefill, onOpenChatWith, onOpenChat, onChange = () => {} }) {
  const [viewType, setViewType] = useState("calendar");
  const [view, setView] = useState({
    level: "year",
    anchor: new Date(new Date().getFullYear(), 0, 1),
  });
  const [calSpan, setCalSpan] = useState("month");
  const [calAnchor, setCalAnchor] = useState(() => startOfDay(new Date()));
  // The editable day planner (timetable blocks / blockers / commitments)
  // opens when a day is clicked in the calendar view.
  const [selectedDay, setSelectedDay] = useState(null);
  const [quickAddType, setQuickAddType] = useState(null);
  const [selectedTimelineItem, setSelectedTimelineItem] = useState(null);
  // Option B — a gentle re-plan offer surfaced after a milestone's tasks all
  // complete. Never auto-fires; the user chooses.
  const [replanOffer, setReplanOffer] = useState(null);
  // Timetable blocks — fetched separately (they aren't part of /api/state).
  // Drives the Google-Calendar hour grid on the Day/Week spans.
  const [timetableBlocks, setTimetableBlocks] = useState([]);
  useEffect(() => {
    api
      .timetable()
      .then((r) => setTimetableBlocks(r?.blocks || []))
      .catch(() => {});
  }, [state]);
  const dayPlannerRef = useRef(null);
  // The planner renders below the (tall) month grid, so scroll it into
  // view on open — otherwise clicking a day near the bottom looks like a
  // no-op.
  useEffect(() => {
    if (!selectedDay) return;
    const t = setTimeout(() => {
      dayPlannerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 60);
    return () => clearTimeout(t);
  }, [selectedDay]);

  const today = useMemo(() => startOfDay(new Date()), []);

  // Iteration 5 (Bug 11) — prefer the scoped opener so tile-chip
  // clicks carry `scope`/`refId`/`kind` into the new conversation.
  // Falls back to onOpenChat / onPrefill (string-only) for legacy
  // mounts (e.g. storyboard).
  const openChat = useCallback(
    (prefill, scope) => {
      if (typeof onOpenChatWith === "function") {
        onOpenChatWith(prefill, scope);
        return;
      }
      const legacy = onOpenChat || onPrefill;
      if (typeof legacy === "function") legacy(prefill);
    },
    [onOpenChatWith, onOpenChat, onPrefill],
  );

  const openQuickAdd = (type) => {
    setSelectedDay(startOfDay(new Date()));
    setQuickAddType(type);
  };

  /* ---------- collect & normalize data from state ---------- */

  const goals = useMemo(
    () => (state?.goals || []).filter((g) => g.status !== "dropped"),
    [state],
  );

  const milestones = useMemo(
    () =>
      (state?.milestones || [])
        .map((m) => ({
          ...m,
          date: parse(m.target_date),
          goalId: m.goal_id,
          goalTitle:
            m.goal_title ||
            (m.goal_id && goals.find((g) => g.id === m.goal_id)?.title) ||
            "",
        }))
        .filter((m) => m.date && m.status !== "done"),
    [state, goals],
  );

  const blockers = useMemo(
    () =>
      (state?.blockers || [])
        .map((b) => ({
          ...b,
          start: parse(b.start_date),
          end: parse(b.end_date) || parse(b.start_date),
        }))
        .filter((b) => b.start),
    [state],
  );

  const openCommitments = useMemo(
    () => (state?.commitments || []).filter((c) => c.status === "open"),
    [state],
  );

  // Per-day plan tasks from the multi-horizon lattice (plan_items). Marked by a
  // "Fulfils …" note; commitment-derived daily rows are the others.
  const planTasks = useMemo(
    () =>
      (state?.plan_items || []).filter(
        (p) => p.horizon === "daily" && (p.note || "").startsWith("Fulfils"),
      ),
    [state],
  );

  const recentActivity = useMemo(() => {
    const events = [];
    (state?.audit_summary?.recent || []).forEach((a) => {
      const d = a.created_at ? new Date(a.created_at) : null;
      if (d) events.push({ date: d, kind: a.type || "event", label: a.summary || a.type });
    });
    (state?.sources || []).forEach((s) => {
      const d = s.created_at ? new Date(s.created_at) : null;
      if (d) events.push({ date: d, kind: s.kind || "source", label: s.original_filename || "source" });
    });
    return events.sort((a, b) => a.date - b.date);
  }, [state]);

  /* single time-ordered items list — used by drill buckets and calendar. */
  const allItems = useMemo(() => {
    const out = [];
    goals.forEach((g) => {
      const explicitEnd = parse(g.target_date);
      const win = goalWindow(g, today);
      out.push({
        kind: "goal",
        // `date` is the item's anchor date for the drill buckets / sorting;
        // the calendar uses the explicit `start` / `end` span below.
        date: explicitEnd || win.start,
        start: win.start,
        end: win.end,
        id: g.id,
        title: g.title,
        horizon: g.horizon,
        status: g.status,
        // Surfaced in the tile tooltip so the user can tell a real
        // target date from a horizon-derived estimate.
        inferredSpan: win.inferred,
      });
    });
    milestones.forEach((m) => {
      out.push({
        kind: "milestone",
        date: m.date,
        start: m.date,
        end: m.date,
        id: m.id,
        title: m.title || "Milestone",
        goalTitle: m.goalTitle,
        status: m.status,
      });
    });
    openCommitments.forEach((c) => {
      const d = parse(c.due);
      if (d)
        out.push({
          kind: "commitment",
          date: d,
          start: d,
          end: d,
          id: c.id,
          title: c.text,
          goalTitle: c.goal_title,
          goalId: c.goal_id,
          status: c.status,
        });
    });
    blockers.forEach((b) => {
      out.push({
        kind: "blocker",
        date: b.start,
        start: b.start,
        end: b.end || b.start,
        id: b.id,
        title: b.title,
        note: b.note,
      });
    });
    planTasks.forEach((p) => {
      const d = parse(p.due_date);
      if (!d) return;
      out.push({
        kind: "task",
        date: d,
        start: d,
        end: d,
        id: p.id,
        title: p.title,
        note: p.note,
        phase: p.phase,
        goalId: p.goal_id,
        status: p.status,
      });
    });
    return out.sort((a, b) => a.date - b.date);
  }, [goals, milestones, openCommitments, blockers, planTasks, today]);

  // Option C calendar cards — one 3-line breadcrumb card per item, enriched
  // with the goal (title + colour), the commitment a task advances, and the
  // milestone it fulfils. Goals become the stripe/context, not cards.
  const calendarCards = useMemo(() => {
    const colorByGoal = new Map(goals.map((g, i) => [g.id, GOAL_PALETTE[i % GOAL_PALETTE.length]]));
    const openCommitsByGoal = new Map();
    (state?.commitments || [])
      .filter((c) => c.status !== "done")
      .forEach((c) => {
        const key = c.goal_id || c.goal_title || "";
        const arr = openCommitsByGoal.get(key) || [];
        arr.push(c);
        openCommitsByGoal.set(key, arr);
      });
    const out = [];
    for (const it of allItems) {
      if (it.kind === "goal") continue;
      const goalId = it.goalId || it.goal_id || "";
      const goal =
        goals.find((g) => g.id === goalId) ||
        goals.find((g) => g.title === (it.goalTitle || it.goal_title));
      const color =
        it.kind === "blocker"
          ? "var(--danger)"
          : colorByGoal.get(goal?.id) || GOAL_PALETTE[0];
      let commitment = "";
      let fulfils = "";
      let hours = "";
      if (it.kind === "task") {
        const body = (it.note || "").replace(/^Fulfils\s*/, "");
        const [fPart, hPart] = body.split("·");
        fulfils = (fPart || "").replace(/[“”"]/g, "").trim();
        hours = hPart ? hPart.trim() : "";
        const cands =
          openCommitsByGoal.get(goalId) ||
          openCommitsByGoal.get(it.goalTitle || it.goal_title || "") ||
          [];
        const samePhase = cands.filter((c) => (c.phase || "") === (it.phase || ""));
        commitment = (samePhase[0] || cands[0])?.text || "";
      }
      out.push({
        id: it.id,
        item: it,
        date: it.date,
        glyph:
          it.kind === "commitment" ? "⚑" : it.kind === "milestone" ? "◆" : it.kind === "blocker" ? "▲" : "○",
        title: it.title,
        goalTitle: goal?.title || it.goalTitle || it.goal_title || "",
        color,
        commitment,
        fulfils,
        hours,
        status: it.status,
      });
    }
    return out;
  }, [allItems, goals, state]);

  const isEmpty = allItems.length === 0 && goals.length === 0;

  const statsData = useMemo(
    () => ({
      goals: goals.length,
      milestones: milestones.length,
      commitments: openCommitments.length,
      blockers: blockers.length,
      activity: recentActivity.length,
      drift: allItems.filter(
        (it) => it.kind !== "goal" && it.date < today && (it.status || "open") !== "done",
      ).length,
    }),
    [goals, milestones, openCommitments, blockers, recentActivity, allItems, today],
  );

  /* ---------- drill nav helpers ---------- */

  const drill = (b) => b.next && setView({ level: b.next, anchor: b.start });
  const goBack = () => {
    const a = view.anchor;
    if (view.level === "quarter") setView({ level: "year", anchor: new Date(a.getFullYear(), 0, 1) });
    else if (view.level === "month")
      setView({ level: "quarter", anchor: new Date(a.getFullYear(), Math.floor(a.getMonth() / 3) * 3, 1) });
    else if (view.level === "week")
      setView({ level: "month", anchor: new Date(a.getFullYear(), a.getMonth(), 1) });
  };
  const shiftYear = (delta) => {
    const a = view.anchor;
    setView({ level: view.level, anchor: new Date(a.getFullYear() + delta, a.getMonth(), 1) });
  };

  const crumbs = useMemo(() => {
    const out = [];
    const ay = view.anchor.getFullYear();
    out.push({
      label: `${ay}`,
      onClick: () => setView({ level: "year", anchor: new Date(ay, 0, 1) }),
    });
    if (["quarter", "month", "week"].includes(view.level)) {
      const q = Math.floor(view.anchor.getMonth() / 3);
      out.push({
        label: `Q${q + 1}`,
        onClick: () => setView({ level: "quarter", anchor: new Date(ay, q * 3, 1) }),
      });
    }
    if (["month", "week"].includes(view.level)) {
      const m = view.anchor.getMonth();
      out.push({
        label: MONTHS[m],
        onClick: () => setView({ level: "month", anchor: new Date(ay, m, 1) }),
      });
    }
    if (view.level === "week") {
      const ws = startOfWeek(view.anchor);
      out.push({ label: fmtDay(ws), onClick: null });
    }
    return out;
  }, [view]);

  const buckets = useMemo(() => makeBuckets(view.level, view.anchor), [view]);
  const itemsIn = (s, e) => allItems.filter((it) => it.date >= s && it.date < e);
  const blockersIn = (s, e) =>
    blockers.filter((b) => b.start < e && (b.end || b.start) >= s);

  /* ---------- keyboard shortcuts ---------- */
  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape" && viewType === "drill" && view.level !== "year") {
        e.preventDefault();
        goBack();
        return;
      }
      if (viewType === "calendar") {
        const preset = CAL_SPANS.find((s) => s.key === calSpan);
        const spanIdx = CAL_SPANS.findIndex((s) => s.key === calSpan);
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setCalAnchor((a) => addDays(a, preset?.days || 30));
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          setCalAnchor((a) => addDays(a, -(preset?.days || 30)));
        } else if (e.key === "t" || e.key === "T") {
          e.preventDefault();
          setCalAnchor(startOfDay(new Date()));
        } else if (["1", "2", "3", "4", "5"].includes(e.key)) {
          const idx = clamp(parseInt(e.key, 10) - 1, 0, CAL_SPANS.length - 1);
          if (CAL_SPANS[idx]) {
            e.preventDefault();
            setCalSpan(CAL_SPANS[idx].key);
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewType, calSpan, view.level]);

  /* ---------- empty state ---------- */

  return (
    <div data-testid="timeline-view" className="p-3 sm:p-5 md:p-6 space-y-4">
      <HeaderStrip
        viewType={viewType}
        setViewType={setViewType}
        view={view}
        crumbs={crumbs}
        goBack={goBack}
        shiftYear={shiftYear}
        stats={statsData}
        calSpan={calSpan}
        setCalSpan={setCalSpan}
        calAnchor={calAnchor}
        setCalAnchor={setCalAnchor}
        today={today}
        onQuickAdd={openQuickAdd}
      />

      {isEmpty ? (
        <EmptyState onPrefill={onPrefill} onOpenChatWith={onOpenChatWith} />
      ) : viewType === "drill" ? (
        <DrillView
          buckets={buckets}
          itemsIn={itemsIn}
          blockersIn={blockersIn}
          today={today}
          level={view.level}
          drill={drill}
          stats={statsData}
        />
      ) : viewType === "strip" ? (
        <StripView state={state} goals={goals} today={today} openChat={openChat} onSelectItem={setSelectedTimelineItem} onPrefill={onPrefill} />
      ) : (
        <CalendarView
          allItems={allItems}
          cards={calendarCards}
          planItems={state?.plan_items || []}
          goals={goals}
          milestones={milestones}
          commitments={openCommitments}
          blockers={blockers}
          today={today}
          span={calSpan}
          setSpan={setCalSpan}
          anchor={calAnchor}
          setAnchor={setCalAnchor}
          openChat={openChat}
          onSelectItem={setSelectedTimelineItem}
          onPrefill={onPrefill}
          onSelectDay={setSelectedDay}
          blocks={timetableBlocks}
          onSelectSlot={(d) => {
            if (d) setSelectedDay(startOfDay(d));
            setQuickAddType("block");
          }}
        />
      )}

      {selectedDay && (
        <CenteredDialog
          open
          onClose={() => { setSelectedDay(null); setQuickAddType(null); }}
          title={`Add to ${selectedDay.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`}
          subtitle="Commitments, blockers, and time blocks for this day."
          maxWidth="max-w-lg"
          testId="day-add-dialog"
        >
          <div ref={dayPlannerRef}>
            <DayPlanner
              day={selectedDay}
              state={state}
              onChange={onChange}
              onClose={() => { setSelectedDay(null); setQuickAddType(null); }}
              initialAddType={quickAddType}
              onInitialAddTypeHandled={() => setQuickAddType(null)}
              embedded
            />
          </div>
        </CenteredDialog>
      )}
      <TimelineItemDetailsDialog
        item={selectedTimelineItem}
        state={state}
        onClose={() => setSelectedTimelineItem(null)}
        onEdit={() => {
          if (selectedTimelineItem) openChat("", scopeForItem(selectedTimelineItem));
          setSelectedTimelineItem(null);
        }}
        onAddBlocker={() => {
          const d = selectedTimelineItem?.date;
          setSelectedTimelineItem(null);
          if (d) {
            setSelectedDay(startOfDay(d));
            setQuickAddType("blocker");
          }
        }}
        onAddCommitment={() => {
          const d = selectedTimelineItem?.date;
          setSelectedTimelineItem(null);
          if (d) {
            setSelectedDay(startOfDay(d));
            setQuickAddType("commitment");
          }
        }}
        onToggle={async (it) => {
          const next = (it.status || "").toLowerCase() === "done" ? "open" : "done";
          try {
            if (it.kind === "commitment") {
              await api.updateCommitment(it.id, { status: next });
            } else {
              await api.updatePlanItem(it.id, { status: next });
            }
            onChange();
            // Option B — on completion, offer (never auto-fire) a re-plan when
            // the day's/week's work is actually finished, or the milestone is
            // now met. A gentle inline prompt, not a chat turn.
            if (next === "done") {
              const planItems = state?.plan_items || [];
              const targetTitle = (it.note || "").replace(/^Fulfils\s*/, "").split("·")[0].replace(/[“”"]/g, "").trim();
              const sameFulfil = planItems.filter(
                (p) =>
                  p.horizon === "daily" &&
                  (p.note || "").startsWith("Fulfils") &&
                  (p.note || "").replace(/^Fulfils\s*/, "").split("·")[0].replace(/[“”"]/g, "").trim() === targetTitle &&
                  p.id !== it.id,
              );
              const remaining = sameFulfil.filter((p) => (p.status || "open") !== "done");
              if (targetTitle && remaining.length === 0) {
                setReplanOffer({ goalId: it.goal_id || it.goalId, milestone: targetTitle });
              }
            }
            setSelectedTimelineItem(null);
          } catch (e) {
            toast.error("Couldn't update — try again.");
          }
        }}
      />

      {/* Option B — gentle re-plan offer (never auto-fires). */}
      {replanOffer && (
        <div
          data-testid="replan-offer"
          className="fixed inset-x-0 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 shadow-lg"
        >
          <span className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--text-secondary)]">
            You finished &ldquo;{replanOffer.milestone}&rdquo;. Want the coach to re-plan what&rsquo;s next?
          </span>
          <button
            type="button"
            data-testid="replan-offer-replan"
            onClick={() => {
              openChat(
                `I completed "${replanOffer.milestone}". Re-plan what's next for this goal.`,
                { scope: "goal", kind: "review_progress", refId: replanOffer.goalId, title: "Re-plan", helperText: "The milestone's work is done — propose the next step." },
              );
              setReplanOffer(null);
            }}
            className="min-h-9 rounded-md bg-[var(--accent)] px-3 text-[12px] font-medium text-[var(--bg-primary)] hover:opacity-90"
          >
            Re-plan
          </button>
          <button
            type="button"
            data-testid="replan-offer-dismiss"
            onClick={() => setReplanOffer(null)}
            className="min-h-9 rounded-md border border-[var(--border)] px-3 text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Not now
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * HeaderStrip — view-type dropdown + drill crumbs / cal nav / stats.
 * ========================================================================= */

function HeaderStrip({
  viewType,
  setViewType,
  view,
  crumbs,
  goBack,
  shiftYear,
  stats,
  calSpan,
  setCalSpan,
  calAnchor,
  setCalAnchor,
  today,
  onQuickAdd,
}) {
  const activeView = VIEW_TYPES.find((v) => v.key === viewType) || VIEW_TYPES[0];
  const ActiveIcon = activeView.Icon;
  // Below `sm` the header stacks, so the Add control gets its own
  // right-aligned row under the orientation line instead of the nav row.
  const isNarrow = !useMediaQuery("(min-width: 640px)");

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
        {/* View-type dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="timeline-viewtype-trigger"
              aria-label="Choose how to view your timeline"
              className="inline-flex items-center gap-2 h-11 sm:h-9 px-3 rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)] hover:border-[var(--border-accent)] hover:bg-[var(--bg-secondary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
            >
              <ActiveIcon className="w-3.5 h-3.5 text-[var(--accent)]" aria-hidden="true" />
              <span className="text-[14px] font-semibold text-[var(--text-primary)]">
                {activeView.label}
              </span>
              <span className="hidden sm:inline text-xs text-[var(--text-muted)] max-w-[180px] truncate">
                — {activeView.sub}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)] ml-1" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="font-medium text-xs text-[var(--text-muted)]">
              View type
            </DropdownMenuLabel>
            {VIEW_TYPES.map((v) => {
              const Icon = v.Icon;
              const active = v.key === viewType;
              return (
                <DropdownMenuItem
                  key={v.key}
                  data-testid={`timeline-viewtype-${v.key}`}
                  onSelect={() => setViewType(v.key)}
                  className="flex items-start gap-3 py-2.5 cursor-pointer"
                >
                  <Icon
                    className={`w-4 h-4 mt-0.5 shrink-0 ${active ? "text-[var(--accent)]" : "text-[var(--text-secondary)]"}`}
                    aria-hidden="true"
                  />
                  <div className="flex-1 min-w-0">
                    <div className={`text-[13px] font-medium ${active ? "text-[var(--accent)]" : "text-[var(--text-primary)]"}`}>
                      {v.label}
                      {active && <span className="ml-2 text-xs uppercase text-[var(--accent)]">· now</span>}
                    </div>
                    <div className="text-xs text-[var(--text-muted)] mt-0.5 leading-snug">
                      {v.sub}
                    </div>
                  </div>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {viewType === "drill" && view.level !== "year" && (
          <button
            data-testid="timeline-back"
            onClick={goBack}
            className="min-h-11 flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
          >
            <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" /> Back
          </button>
        )}
        {viewType === "drill" && (
          <div
            className="flex items-center gap-2 text-xs text-[var(--text-muted)]"
            data-testid="timeline-crumbs"
          >
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 && <span className="opacity-40">/</span>}
                {c.onClick ? (
                  <button onClick={c.onClick} className="min-h-11 min-w-11 inline-flex items-center justify-center hover:text-[var(--accent)] transition-colors">
                    {c.label}
                  </button>
                ) : (
                  <span className="text-[var(--accent)]">{c.label}</span>
                )}
              </span>
            ))}
          </div>
        )}
        {viewType === "drill" && (
          <div className="flex items-center gap-2 ml-1">
            <button
              data-testid="timeline-prev-year"
              onClick={() => shiftYear(-1)}
              className="h-11 w-11 sm:h-9 sm:w-9 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              title="Previous year"
              aria-label="Previous year"
            >
              <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              data-testid="timeline-next-year"
              onClick={() => shiftYear(1)}
              className="h-11 w-11 sm:h-9 sm:w-9 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              title="Next year"
              aria-label="Next year"
            >
              <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* Narrow screens get the Add control on its own right-aligned row
            below the orientation line — packed into the nav row it squeezes
            Today against the month label. Wider screens keep it beside the
            nav so it sits next to Today. */}
        {viewType === "calendar" ? (
          <CalendarNav
            span={calSpan}
            setSpan={setCalSpan}
            anchor={calAnchor}
            setAnchor={setCalAnchor}
            today={today}
          />
        ) : null}

        <div
          className="ml-auto flex items-center gap-x-3 sm:gap-x-4 gap-y-1 tabular-nums text-xs text-[var(--text-muted)] flex-wrap"
          data-testid="timeline-stats"
        >
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--accent)" }} />
            <span className="text-[var(--text-secondary)] tabular-nums">{stats.goals}</span>
            <span className="hidden sm:inline" aria-hidden="true">goals</span>
            <span className="sr-only">goals</span>
          </span>
          <span className="flex items-center gap-1.5">
            <MilestoneIcon className="w-2.5 h-2.5 text-[var(--warning)]" aria-hidden="true" />
            <span className="text-[var(--text-secondary)] tabular-nums">{stats.milestones}</span>
            <span className="hidden sm:inline" aria-hidden="true">milestones</span>
            <span className="sr-only">milestones</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Flag className="w-2.5 h-2.5 text-[var(--accent)]" aria-hidden="true" />
            <span className="text-[var(--text-secondary)] tabular-nums">{stats.commitments}</span>
            <span className="hidden sm:inline" aria-hidden="true">commitments</span>
            <span className="sr-only">open commitments</span>
          </span>
          <span className="flex items-center gap-1.5">
            <AlertOctagon className="w-2.5 h-2.5 text-[var(--warning)]" aria-hidden="true" />
            <span className="text-[var(--text-secondary)] tabular-nums">{stats.blockers}</span>
            <span className="hidden sm:inline" aria-hidden="true">blockers</span>
            <span className="sr-only">blockers</span>
          </span>
          {stats.drift > 0 && (
            <span
              className="flex items-center gap-1.5 text-[var(--danger)]"
              data-testid="timeline-drift"
              title="Past-due items"
            >
              <Circle className="w-2 h-2 fill-current" aria-hidden="true" />
              <span className="tabular-nums">{stats.drift}</span>
              <span className="hidden sm:inline" aria-hidden="true">past due</span>
              <span className="sr-only">past due</span>
            </span>
          )}
        </div>
      </div>

      {/* One-line orientation — the founder read Timeline as "goals only";
          make it explicit that commitments/milestones (the things that
          actually move a goal) live here too. */}
      <p className="text-xs text-[var(--text-muted)] px-1">
        Your goals and the commitments &amp; milestones that move them, laid out
        across the days they're due.
      </p>
      {isNarrow && viewType === "calendar" && (
        <div className="flex justify-end items-center gap-2">
          <TimelineTodayButton onClick={() => setCalAnchor(startOfDay(new Date()))} />
        </div>
      )}
    </div>
  );
}

/**
 * Today — one control, two placements: beside the month label in the nav row
 * on wide screens, or immediately left of the Add button on narrow screens
 * where the header stacks. Kept as a component so the label/styling/ARIA stay
 * identical in both spots; only one instance is ever in the DOM.
 */
function TimelineTodayButton({ onClick }) {
  return (
    <button
      type="button"
      data-testid="timeline-today-button"
      onClick={onClick}
      className="font-medium h-11 sm:h-9 px-2.5 rounded text-xs border border-[var(--border)] hover:border-[var(--border-accent)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{ background: "var(--bg-secondary)" }}
      title="Jump to today in this view"
    >
      Today
    </button>
  );
}

function TimelineAddMenu({ onAdd }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="timeline-add-trigger"
          aria-label="Add to timeline"
          className="font-medium inline-flex items-center gap-1.5 h-11 sm:h-9 px-2.5 rounded text-xs border border-[var(--border)] hover:border-[var(--border-accent)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ background: "var(--bg-secondary)" }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Add to today</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="timeline-add-block" onSelect={() => onAdd?.("block")}>
          <Clock className="mr-2 h-4 w-4" aria-hidden="true" /> Time block
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="timeline-add-commitment" onSelect={() => onAdd?.("commitment")}>
          <Flag className="mr-2 h-4 w-4" aria-hidden="true" /> Commitment
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="timeline-add-blocker" onSelect={() => onAdd?.("blocker")}>
          <AlertOctagon className="mr-2 h-4 w-4" aria-hidden="true" /> Blocker
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ============================================================================
 * CalendarNav — span chips + prev/next/today for the Calendar view.
 * ========================================================================= */

function CalendarNav({ span, setSpan, anchor, setAnchor, today, children }) {
  const preset = CAL_SPANS.find((s) => s.key === span) || CAL_SPANS[2];
  const stepDays = preset.days;
  // Mobile-first (Wave B decision #5): below sm the span pills render as a
  // select-options button — never a wrapping/scrolling pill row — and the
  // Today control moves down to sit left of Add so both share one row.
  // From sm up the original tablist chips and Today stay here, unchanged.
  const isNarrow = !useMediaQuery("(min-width: 640px)");
  const showSpanSelect = isNarrow;

  // Date picker opened from the month label — jump straight to a day
  // instead of clicking prev/next across months.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickMonth, setPickMonth] = useState(() => startOfDay(anchor));

  const openPicker = (open) => {
    if (open) setPickMonth(startOfDay(anchor));
    setPickerOpen(open);
  };

  const pickDays = useMemo(() => {
    const first = new Date(pickMonth.getFullYear(), pickMonth.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // Mon-first, matches startOfWeek
    const count = new Date(pickMonth.getFullYear(), pickMonth.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(null);
    for (let d = 1; d <= count; d++) {
      cells.push(new Date(pickMonth.getFullYear(), pickMonth.getMonth(), d));
    }
    return cells;
  }, [pickMonth]);

  const jumpToDay = (d) => {
    setAnchor(startOfDay(d));
    setSpan("day");
    setPickerOpen(false);
  };

  const label = useMemo(() => {
    const a = anchor;
    if (span === "day") return fmtMonth(a);
    if (span === "week") {
      const ws = startOfWeek(a);
      const we = addDays(ws, 6);
      return `${fmtDay(ws)} – ${fmtDay(we)}, ${we.getFullYear()}`;
    }
    if (span === "month") return fmtMonth(a);
    if (span === "quarter") {
      const q = Math.floor(a.getMonth() / 3) * 3;
      const qEnd = new Date(a.getFullYear(), q + 3, 0);
      return `Q${Math.floor(a.getMonth() / 3) + 1} ${a.getFullYear()} (${MONTHS[q]} – ${MONTHS[qEnd.getMonth()]})`;
    }
    return `${a.getFullYear()}`;
  }, [anchor, span]);

  const isToday = useMemo(() => {
    if (span === "day") return sameDay(anchor, today);
    if (span === "week") {
      const ws = startOfWeek(anchor);
      const we = addDays(ws, 7);
      return today >= ws && today < we;
    }
    if (span === "month") return anchor.getFullYear() === today.getFullYear() && anchor.getMonth() === today.getMonth();
    if (span === "quarter") return anchor.getFullYear() === today.getFullYear() && Math.floor(anchor.getMonth() / 3) === Math.floor(today.getMonth() / 3);
    return anchor.getFullYear() === today.getFullYear();
  }, [anchor, span, today]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {showSpanSelect ? (
        <Select value={span} onValueChange={setSpan}>
          <SelectTrigger
            data-testid="timeline-cal-span-select"
            aria-label="Calendar span"
            className="h-11 w-auto min-w-36 text-xs font-medium border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)] text-[var(--text-primary)] rounded-md"
          >
            <SelectValue placeholder="Span" />
          </SelectTrigger>
          <SelectContent>
            {CAL_SPANS.map((s) => (
              <SelectItem key={s.key} value={s.key} className="min-h-11 text-sm">
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div
          className="inline-flex rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)] p-0.5"
          role="tablist"
          aria-label="Calendar span"
        >
          {CAL_SPANS.map((s) => (
            <button
              key={s.key}
              type="button"
              data-testid={`timeline-cal-span-${s.key}`}
              onClick={() => setSpan(s.key)}
              role="tab"
              aria-selected={span === s.key}
              className={`font-medium h-11 sm:h-9 min-w-11 px-2 sm:px-2.5 text-xs transition-colors rounded ${
                span === s.key
                  ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--accent)]"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setAnchor((a) => addDays(a, -stepDays))}
          className="h-11 w-11 sm:h-9 sm:w-9 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          title="Previous"
          aria-label="Previous"
        >
          <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <Popover open={pickerOpen} onOpenChange={openPicker}>
          <h2
            className="text-[15px] sm:text-[17px] font-semibold text-[var(--text-primary)] tracking-tight min-w-[140px] sm:min-w-[200px] text-center"
            aria-live="polite"
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                data-testid="timeline-month-label"
                aria-label={`${label} — pick a day to jump to`}
                className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 -mx-1.5 hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                {label}
                <CalendarClock className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-hidden="true" />
              </button>
            </PopoverTrigger>
          </h2>
          <PopoverContent align="center" className="w-[280px] p-3">
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() =>
                  setPickMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))
                }
                className="h-8 w-8 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors"
                title="Previous month"
                aria-label="Previous month"
              >
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              </button>
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                {fmtMonth(pickMonth)}
              </span>
              <button
                type="button"
                onClick={() =>
                  setPickMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))
                }
                className="h-8 w-8 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors"
                title="Next month"
                aria-label="Next month"
              >
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 mb-1" aria-hidden="true">
              {DOW_SHORT.map((d, i) => (
                <span
                  key={`${d}-${i}`}
                  className="h-6 flex items-center justify-center text-[10px] font-medium text-[var(--text-muted)]"
                >
                  {d}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {pickDays.map((d, i) =>
                d ? (
                  <button
                    key={d.toISOString()}
                    type="button"
                    onClick={() => jumpToDay(d)}
                    className={`h-8 rounded text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                      sameDay(d, anchor)
                        ? "bg-[var(--accent)] text-[var(--bg-primary)] font-semibold"
                        : sameDay(d, today)
                        ? "border border-[var(--accent)] text-[var(--accent)] font-semibold"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                    }`}
                    aria-label={`Jump to ${fmtMonth(d)} ${d.getDate()}`}
                  >
                    {d.getDate()}
                  </button>
                ) : (
                  <span key={`pad-${i}`} className="h-8" aria-hidden="true" />
                ),
              )}
            </div>
          </PopoverContent>
        </Popover>
        <button
          type="button"
          onClick={() => setAnchor((a) => addDays(a, stepDays))}
          className="h-11 w-11 sm:h-9 sm:w-9 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          title="Next"
          aria-label="Next"
        >
          <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        {!isNarrow && (
          <TimelineTodayButton onClick={() => setAnchor(startOfDay(new Date()))} />
        )}
        {children}
      </div>
    </div>
  );
}

/* ============================================================================
 * EmptyState — calmer, more inviting; keeps the prefill CTA.
 * ========================================================================= */

function EmptyState({ onPrefill, onOpenChatWith }) {
  // Scoped chat context — opens the chat in "About: Build my timeline"
  // mode with a helper hint, instead of the generic empty state. Without
  // this the CTA landed the user in the generic coach chat with no
  // indication of what they were about to talk about.
  const onBuildTimeline = () => {
    const helperText =
      "What does a realistic timeline look like for my goals — proposed target dates and 2-4 milestones each, with buffer for real life.";
    if (typeof onOpenChatWith === "function") {
      onOpenChatWith("", {
        scope: "generic",
        kind: "plan_day",
        title: "Build my timeline",
        helperText,
      });
      return;
    }
    if (typeof onPrefill === "function") {
      onPrefill(
        "Map out a realistic timeline for my goals — propose target dates and 2-4 milestones each, with buffer for real life.",
      );
    }
  };

  return (
    <div data-testid="timeline-empty-state" className="px-4 sm:px-6 py-5 sm:py-6 max-w-[900px] mx-auto w-full">
      <div className="relative overflow-hidden rounded-2xl bg-[var(--bg-secondary)] px-6 py-10 sm:py-14 text-center">
        <svg
          aria-hidden="true"
          className="mx-auto mb-5 opacity-90"
          width="160"
          height="56"
          viewBox="0 0 160 56"
        >
          <rect x="0.5" y="0.5" width="159" height="55" rx="6" fill="var(--bg-tertiary)" stroke="var(--border)" />
          {[...Array(30)].map((_, i) => {
            const x = (i % 10) * 15 + 6;
            const y = Math.floor(i / 10) * 18 + 10;
            const isToday = i === 14;
            return (
              <rect
                key={i}
                x={x}
                y={y}
                width="12"
                height="12"
                rx="2"
                fill={isToday ? "var(--accent)" : "var(--bg-secondary)"}
                stroke={isToday ? "var(--accent)" : "var(--border)"}
                opacity={isToday ? 1 : 0.7}
              />
            );
          })}
          <line x1="0" y1="28" x2="160" y2="28" stroke="var(--border-accent)" strokeWidth="0.5" opacity="0.5" />
        </svg>

        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[var(--bg-tertiary)] mb-3">
          <CalendarClock className="w-5 h-5 text-[var(--accent)]" aria-hidden="true" />
        </div>

        <h2 className="text-base sm:text-lg font-medium text-[var(--text-primary)] font-display">
          Nothing on your timeline yet
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed max-w-md mx-auto">
          Ask the coach to sketch a realistic timeline — it'll propose target dates and a few
          milestones per goal, with buffer built in.
        </p>

        {(onOpenChatWith || onPrefill) && (
          <button
            data-testid="timeline-prefill-button"
            onClick={onBuildTimeline}
            className="font-semibold mt-4 min-h-11 inline-flex items-center gap-1.5 px-5 py-2.5 text-sm text-[var(--bg-primary)] bg-[var(--accent)] hover:opacity-90 transition-opacity rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]"
          >
            Ask the coach to build my timeline
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
 * DrillView — bucketed day-by-day view (kept verbatim from the original).
 * ========================================================================= */

function DrillView({ buckets, itemsIn, blockersIn, today, level, drill, stats }) {
  return (
    <>
      <div
        className={`grid gap-3 ${level === "week" ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}
      >
        {buckets.map((b, idx) => {
          const its = itemsIn(b.start, b.end);
          const bls = blockersIn(b.start, b.end);
          const drift = its.filter((it) => it.kind !== "goal" && !it.done && it.date < today);
          const isNow = today >= b.start && today < b.end;
          const clickable = !!b.next;

          const goalsInBucket = its.filter((it) => it.kind === "goal");
          const msInBucket = its.filter((it) => it.kind === "milestone");
          const csInBucket = its.filter((it) => it.kind === "commitment");
          const bsInBucket = bls;

          return (
            <div
              key={idx}
              data-testid={`timeline-bucket-${level}-${idx}`}
              className={`group relative border rounded transition-colors overflow-hidden ${
                isNow
                  ? "border-[var(--accent)] bg-[var(--bg-secondary)]"
                  : "border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)] hover:border-[var(--border-accent)]"
              }`}
            >
              {clickable && (
                <button
                  type="button"
                  onClick={() => drill(b)}
                  aria-label={`Drill into ${b.label}`}
                  className="absolute inset-0 z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-[-2px]"
                />
              )}
              {isNow && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-[var(--accent)]" />}

              <div className="flex items-baseline justify-between gap-2 px-3 pt-2.5">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span
                    className={`text-sm font-medium truncate ${
                      isNow ? "text-[var(--accent)]" : "text-[var(--text-primary)]"
                    }`}
                  >
                    {b.label}
                  </span>
                  {isNow && (
                    <span className="text-xs uppercase px-1.5 py-0.5 rounded bg-[var(--accent)] text-[var(--bg-primary)]">
                      now
                    </span>
                  )}
                </div>
                <span className="text-xs text-[var(--text-muted)] shrink-0">{b.sub}</span>
              </div>

              {(goalsInBucket.length + msInBucket.length + csInBucket.length + bsInBucket.length) > 0 && (
                <div className="flex items-center gap-3 px-3 mt-1.5 tabular-nums text-xs text-[var(--text-muted)]">
                  {goalsInBucket.length > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--accent)" }} />
                      {goalsInBucket.length}g
                    </span>
                  )}
                  {msInBucket.length > 0 && (
                    <span className="flex items-center gap-1">
                      <MilestoneIcon className="w-2.5 h-2.5" aria-hidden="true" />
                      {msInBucket.length}m
                    </span>
                  )}
                  {csInBucket.length > 0 && (
                    <span className="flex items-center gap-1">
                      <Flag className="w-2.5 h-2.5" aria-hidden="true" />
                      {csInBucket.length}c
                    </span>
                  )}
                  {bsInBucket.length > 0 && (
                    <span className="flex items-center gap-1 text-[var(--danger)]">
                      <AlertOctagon className="w-2.5 h-2.5" aria-hidden="true" />
                      {bsInBucket.length}b
                    </span>
                  )}
                  {drift.length > 0 && (
                    <span className="text-[var(--danger)] ml-auto">−{drift.length} past due</span>
                  )}
                </div>
              )}

              <div className="px-3 pt-1.5 pb-2.5 space-y-1 relative z-0">
                {goalsInBucket.map((it) => (
                  <div key={'g-' + it.id} className="flex items-center gap-1.5 text-xs">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: HORIZON_COLOR[it.horizon] || "var(--accent)" }} />
                    <span className="truncate text-[var(--text-primary)]">{it.title}</span>
                    <span className="ml-auto tabular-nums text-xs text-[var(--text-muted)] shrink-0">
                      {fmtIso(it.date)}
                    </span>
                  </div>
                ))}
                {msInBucket.map((it) => (
                  <div key={'m-' + it.id} className="flex items-center gap-1.5 text-xs">
                    <MilestoneIcon className="w-3 h-3 text-[var(--warning)] shrink-0" aria-hidden="true" />
                    <span className="truncate text-[var(--text-secondary)]">{it.title}</span>
                    <span className="ml-auto tabular-nums text-xs text-[var(--text-muted)] shrink-0">
                      {fmtIso(it.date)}
                    </span>
                  </div>
                ))}
                {csInBucket.map((it) => (
                  <div key={'c-' + it.id} className="flex items-center gap-1.5 text-xs">
                    <Flag className="w-3 h-3 text-[var(--accent)] shrink-0" aria-hidden="true" />
                    <span className="truncate text-[var(--text-secondary)]">{it.title}</span>
                    <span className="ml-auto tabular-nums text-xs text-[var(--text-muted)] shrink-0">
                      {fmtIso(it.date)}
                    </span>
                  </div>
                ))}
                {bsInBucket.map((b, i) => (
                  <div key={'b-' + i} className="flex items-center gap-1.5 text-xs">
                    <AlertOctagon className="w-3 h-3 text-[var(--danger)] shrink-0" aria-hidden="true" />
                    <span className="truncate text-[var(--danger)]">{b.title}</span>
                  </div>
                ))}
                {its.length === 0 && bsInBucket.length === 0 && (
                  <div className="text-xs text-[var(--text-muted)] italic">nothing scheduled</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ============================================================================
 * StripView — "At a glance" horizon strips (ported from TimelineVariantB).
 * ========================================================================= */

function bucketFromDate(d, today) {
  if (!d) return "later";
  const diff = daysUntil(d, today);
  if (diff <= 0) return "today";
  if (diff <= 7) return "thisWeek";
  if (diff <= 30) return "thisMonth";
  if (diff <= 90) return "thisQuarter";
  if (diff <= 365) return "thisYear";
  return "later";
}

const HORIZON_PILL = {
  weekly: { bg: "var(--accent)", fg: "var(--bg-primary)", label: "WK" },
  short: { bg: "var(--warning)", fg: "var(--on-warning)", label: "SHORT" },
  medium: { bg: "var(--accent)", fg: "var(--bg-primary)", label: "MED" },
  long: { bg: "var(--success)", fg: "var(--bg-primary)", label: "LONG" },
};

function StripView({ state, today, openChat, onSelectItem, onPrefill }) {
  const buckets = useMemo(() => {
    const out = Object.fromEntries(HORIZONS.map((h) => [h.key, []]));
    const push = (kind, item, date) => {
      const k = bucketFromDate(date, today);
      out[k].push({ kind, item, date });
    };
    (state?.goals || []).forEach((g) => {
      const d = parse(g.target_date) || parse(g.start_date) || today;
      push("goal", g, d);
    });
    (state?.milestones || []).forEach((m) => {
      const d = parse(m.target_date) || today;
      push("milestone", m, d);
    });
    (state?.commitments || []).forEach((c) => {
      if (c.status === "done") return;
      const d = parse(c.due) || today;
      push("commitment", c, d);
    });
    (state?.blockers || []).forEach((b) => {
      if (b.end_date && new Date(b.end_date) < today) return;
      out.today.push({ kind: "blocker", item: b, date: today });
    });
    return out;
  }, [state, today]);

  const totals = useMemo(() => {
    const goals = state?.goals?.length || 0;
    const openCommitments = (state?.commitments || []).filter(
      (c) => c.status !== "done",
    ).length;
    const milestones = state?.milestones?.length || 0;
    const blockers = (state?.blockers || []).filter(
      (b) => !b.end_date || new Date(b.end_date) >= today,
    ).length;
    return { goals, openCommitments, milestones, blockers };
  }, [state, today]);

  const totalItems = HORIZONS.reduce((sum, h) => sum + buckets[h.key].length, 0);

  if (totalItems === 0) {
    return <StripEmptyState onAsk={openChat || onPrefill} />;
  }

  const handlers = {
    // Scoped openers — empty input, entity pinned in the conversation
    // (same pattern as CalendarTile). No canned "Let's focus on…" prefills.
    goal: (g) => onSelectItem?.({ ...g, kind: "goal" }),
    commitment: (c) =>
      onSelectItem?.({ ...c, kind: "commitment", title: c.text || c.title }),
    milestone: (m) => onSelectItem?.({ ...m, kind: "milestone" }),
    blocker: (b) => onSelectItem?.({ ...b, kind: "blocker" }),
    // Horizon cards have no entity — open a scoped "plan" chat instead of
    // passing the horizon object as a prefill value (it used to render as
    // an object React child).
    horizon: (h) =>
      openChat("", {
        scope: "generic",
        kind: "plan_day",
        title: `Plan my ${h.label.toLowerCase()}`,
        helperText: `What should I commit to in the ${h.label.toLowerCase()} horizon?`,
      }),
  };

  return (
    <div className="flex flex-col gap-5 gc-fade-in" aria-label="Timeline — at a glance">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1 tabular-nums text-xs text-[var(--text-muted)]">
        <span>
          <strong className="text-[var(--text-primary)] font-semibold">{totals.goals}</strong>{" "}
          goals
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <strong className="text-[var(--text-primary)] font-semibold">{totals.milestones}</strong>{" "}
          milestones
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <strong className="text-[var(--text-primary)] font-semibold">{totals.openCommitments}</strong>{" "}
          open commitments
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <strong className="text-[var(--text-primary)] font-semibold">{totals.blockers}</strong>{" "}
          blockers
        </span>
        <span aria-hidden="true" className="hidden sm:inline">·</span>
        <button
          type="button"
          data-testid="timeline-replan-button"
          onClick={() =>
            openChat("", {
              scope: "generic",
              kind: "plan_day",
              title: "Re-plan my timeline",
              helperText:
                "Look at my whole timeline and suggest where to focus this week.",
            })
          }
          className="hidden sm:inline ml-auto text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
        >
          Ask the coach to re-plan
        </button>
      </div>

      <div className="flex flex-col gap-5">
        {HORIZONS.map((h) => {
          const items = buckets[h.key];
          return (
            <section
              key={h.key}
              aria-labelledby={`strip-${h.key}`}
              role="group"
              data-density={items.length === 0 ? "empty" : items.length <= 2 ? "low" : "high"}
            >
              <div id={`strip-${h.key}`} className="flex items-baseline justify-between gap-2 mb-2 px-1">
                <div className="flex items-baseline gap-2 min-w-0">
                  <h3 className="text-[15px] font-semibold text-[var(--text-primary)] truncate">
                    {h.label}
                  </h3>
                  <span className="text-xs text-[var(--text-muted)] truncate">
                    {h.sub}
                  </span>
                </div>
                <span
                  className="tabular-nums text-xs text-[var(--text-secondary)] shrink-0"
                  aria-label={`${items.length} item${items.length === 1 ? "" : "s"}`}
                >
                  {items.length}
                </span>
              </div>
              <StripBody testId={`timeline-b-strip-${h.key}`}>
                {items.length === 0 ? (
                  <EmptyStrip horizon={h} onAsk={handlers.horizon} />
                ) : (
                  items.map((entry) => {
                    if (entry.kind === "goal") {
                      return (
                        <div key={`g-${entry.item.id}`} role="listitem">
                          <GoalCard
                            goal={entry.item}
                            today={today}
                            onActivate={handlers.goal}
                          />
                        </div>
                      );
                    }
                    if (entry.kind === "commitment") {
                      return (
                        <div key={`c-${entry.item.id}`} role="listitem">
                          <CommitmentCard
                            c={entry.item}
                            today={today}
                            onActivate={handlers.commitment}
                          />
                        </div>
                      );
                    }
                    if (entry.kind === "milestone") {
                      return (
                        <div key={`m-${entry.item.id}`} role="listitem">
                          <MilestoneCard
                            m={entry.item}
                            today={today}
                            onActivate={handlers.milestone}
                          />
                        </div>
                      );
                    }
                    if (entry.kind === "blocker") {
                      return (
                        <div key={`b-${entry.item.id}`} role="listitem">
                          <BlockerCard
                            b={entry.item}
                            onActivate={handlers.blocker}
                          />
                        </div>
                      );
                    }
                    return null;
                  })
                )}
              </StripBody>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function StripEmptyState({ onAsk }) {
  return (
    <div
      data-testid="timeline-strip-empty-state"
      className="gc-fade-in flex flex-col items-center justify-center text-center gap-4 py-16 px-6 rounded-2xl bg-[var(--bg-secondary)]"
      role="region"
      aria-label="Timeline empty state"
    >
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center"
        style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
      >
        <CalendarClock size={22} style={{ color: "var(--accent)" }} aria-hidden="true" />
      </div>
      <div className="space-y-2 max-w-md">
        <h3 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
          No goals or commitments yet
        </h3>
        <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Once you and your coach set a goal or commitment, it'll appear here organized by when
          it's due — from today out to the long view.
        </p>
      </div>
      {typeof onAsk === "function" && (
        <button
          type="button"
          data-testid="timeline-prefill-button"
          onClick={() =>
            onAsk("", {
              scope: "generic",
              kind: "plan_day",
              title: "Set my first goal",
              helperText:
                "Help me set my first goal and a small commitment for this week.",
            })
          }
          className="min-h-11 inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[var(--accent)] text-[var(--bg-primary)] font-medium text-[13px] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] transition-all"
        >
          <Sparkles size={14} aria-hidden="true" />
          Ask the coach to start
        </button>
      )}
    </div>
  );
}

function StripBody({ children, testId }) {
  const ref = useRef(null);
  return (
    <div className="relative">
      <div
        ref={ref}
        data-testid={testId}
        className="gc-strip-body flex overflow-x-auto snap-x snap-mandatory gap-3 pb-2 pt-1 -mx-1 px-1"
        role="list"
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-6"
        style={{ background: "linear-gradient(to right, var(--bg-primary), transparent)" }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-6"
        style={{ background: "linear-gradient(to left, var(--bg-primary), transparent)" }}
      />
    </div>
  );
}

function EmptyStrip({ horizon, onAsk }) {
  return (
    <div
      className="snap-start shrink-0 min-w-[260px] w-[280px] sm:w-[300px] rounded-2xl bg-[var(--bg-secondary)] px-4 py-4 flex flex-col items-start gap-2"
      role="note"
      aria-label={`Nothing due ${horizon.label.toLowerCase()}`}
    >
      <Inbox size={14} style={{ color: "var(--text-muted)" }} aria-hidden="true" />
      <div className="text-[13px] leading-snug text-[var(--text-secondary)]">
        Nothing due {horizon.label.toLowerCase()}.
      </div>
      <button
        type="button"
        onClick={() => onAsk(horizon)}
        className="font-medium mt-1 min-h-11 inline-flex items-center text-xs text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded"
      >
        Ask the coach
      </button>
    </div>
  );
}

function HorizonPill({ horizon }) {
  const t = HORIZON_PILL[horizon];
  if (!t) return null;
  return (
    <span
      className="text-xs uppercase px-1.5 py-0.5 rounded"
      style={{ background: t.bg, color: t.fg }}
      aria-label={`horizon: ${horizon}`}
    >
      {t.label}
    </span>
  );
}

function StripStatusDot({ status, kind }) {
  const tone =
    status === "done" || status === "completed"
      ? "var(--success)"
      : status === "overdue" || status === "dropped"
      ? "var(--danger)"
      : kind === "blocker"
      ? "var(--danger)"
      : "var(--accent)";
  return (
    <span
      aria-hidden="true"
      className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
      style={{ background: tone }}
    />
  );
}

function StripMetaLine({ icon: Icon, children, tone = "var(--text-muted)" }) {
  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums text-xs"
      style={{ color: tone }}
    >
      <Icon size={11} aria-hidden="true" />
      {children}
    </span>
  );
}

function StripCardBase({ tone = "var(--bg-secondary)", children, onActivate, testId, label }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      data-testid={testId}
      aria-label={label}
      className={[
        "group text-left rounded-md border transition-all duration-150",
        "min-w-[260px] w-[280px] sm:w-[300px] snap-start shrink-0",
        "p-3.5 flex flex-col gap-2",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]",
        "hover:-translate-y-px hover:border-[var(--border-accent)]",
      ].join(" ")}
      style={{ background: tone, borderColor: "var(--border)" }}
    >
      {children}
    </button>
  );
}

function GoalCard({ goal, today, onActivate }) {
  const target = parse(goal.target_date);
  const days = daysUntil(target, today);
  const tone =
    days !== null && days < 0
      ? "color-mix(in srgb, var(--danger) 8%, var(--bg-secondary))"
      : days !== null && days <= 7
      ? "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))"
      : "var(--bg-secondary)";

  return (
    <StripCardBase
      tone={tone}
      testId={`timeline-b-goal-${goal.id}`}
      label={`Show details for goal ${goal.title}`}
      onActivate={() => onActivate(goal)}
    >
      <div className="flex items-center justify-between gap-2">
        <HorizonPill horizon={goal.horizon} />
        <StripStatusDot status={goal.status} />
      </div>
      <div className="text-[14px] leading-snug font-semibold text-[var(--text-primary)] line-clamp-2">
        {goal.title}
      </div>
      {goal.next_action && (
        <div className="text-[12px] leading-snug text-[var(--text-secondary)] line-clamp-2">
          Next: {goal.next_action}
        </div>
      )}
      <div className="mt-auto pt-2 border-t border-[var(--border)] flex items-center justify-between gap-2">
        {target ? (
          <StripMetaLine icon={Clock} tone={days !== null && days < 0 ? "var(--danger)" : undefined}>
            {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "today" : `${days}d`}
          </StripMetaLine>
        ) : (
          <StripMetaLine icon={Clock}>unscheduled</StripMetaLine>
        )}
      </div>
    </StripCardBase>
  );
}

function CommitmentCard({ c, today, onActivate }) {
  const due = parse(c.due);
  const days = daysUntil(due, today);
  const tone =
    days !== null && days < 0
      ? "color-mix(in srgb, var(--danger) 8%, var(--bg-secondary))"
      : days === 0
      ? "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))"
      : "var(--bg-secondary)";

  return (
    <StripCardBase
      tone={tone}
      testId={`timeline-b-commitment-${c.id}`}
      label={`Show details for commitment ${c.text}`}
      onActivate={() => onActivate(c)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-xs text-[var(--text-secondary)]">
          Commitment
        </span>
        <StripStatusDot status={c.status} kind="commitment" />
      </div>
      <div className="text-[14px] leading-snug text-[var(--text-primary)] line-clamp-3">
        {c.text}
      </div>
      {c.goal_title && (
        <div className="text-xs text-[var(--text-muted)] line-clamp-1">↳ {c.goal_title}</div>
      )}
      <div className="mt-auto pt-2 border-t border-[var(--border)] flex items-center justify-between gap-2">
        {due ? (
          <StripMetaLine icon={Flag} tone={days !== null && days < 0 ? "var(--danger)" : undefined}>
            {days < 0 ? `${Math.abs(days)}d late` : days === 0 ? "today" : `${days}d`}
          </StripMetaLine>
        ) : (
          <StripMetaLine icon={Flag}>no due date</StripMetaLine>
        )}
      </div>
    </StripCardBase>
  );
}

function MilestoneCard({ m, today, onActivate }) {
  const target = parse(m.target_date);
  const days = daysUntil(target, today);
  const tone =
    days !== null && days < 0
      ? "color-mix(in srgb, var(--danger) 8%, var(--bg-secondary))"
      : days === 0
      ? "color-mix(in srgb, var(--accent) 10%, var(--bg-secondary))"
      : "var(--bg-secondary)";

  return (
    <StripCardBase
      tone={tone}
      testId={`timeline-b-milestone-${m.id}`}
      label={`Show details for milestone ${m.title}`}
      onActivate={() => onActivate(m)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-xs text-[var(--text-secondary)]">
          Milestone
        </span>
        <StripStatusDot status={m.status} kind="milestone" />
      </div>
      <div className="text-[14px] leading-snug font-semibold text-[var(--text-primary)] line-clamp-2">
        {m.title}
      </div>
      {m.goal_title && (
        <div className="text-xs text-[var(--text-muted)] line-clamp-1">↳ {m.goal_title}</div>
      )}
      <div className="mt-auto pt-2 border-t border-[var(--border)] flex items-center justify-between gap-2">
        {target ? (
          <StripMetaLine icon={Target} tone={days !== null && days < 0 ? "var(--danger)" : undefined}>
            {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "today" : `${days}d`}
          </StripMetaLine>
        ) : (
          <StripMetaLine icon={Target}>no date</StripMetaLine>
        )}
      </div>
    </StripCardBase>
  );
}

function BlockerCard({ b, onActivate }) {
  return (
    <StripCardBase
      tone="color-mix(in srgb, var(--danger) 8%, var(--bg-secondary))"
      testId={`timeline-b-blocker-${b.id}`}
      label={`Show details for blocker ${b.title}`}
      onActivate={() => onActivate(b)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-xs text-[var(--danger)]">
          Blocker
        </span>
        <AlertOctagon size={11} style={{ color: "var(--danger)" }} aria-hidden="true" />
      </div>
      <div className="text-[14px] leading-snug text-[var(--text-primary)] line-clamp-3">
        {b.title}
      </div>
      <div className="mt-auto pt-2 border-t border-[var(--border)] flex items-center justify-between gap-2">
        <StripMetaLine icon={Clock} tone="var(--danger)">active</StripMetaLine>
      </div>
    </StripCardBase>
  );
}

/* Kind → a short glyph carried in the bar's own label. Status hue is one
 * signal; this is the non-colour one, so a goal never has to be told from
 * a commitment by colour alone. Matches the glyphs CalendarTile uses. */
const KIND_GLYPH = { commitment: "▸ ", milestone: "◆ ", blocker: "! ", goal: "" };
function itemKindGlyph(kind) {
  return KIND_GLYPH[kind] ?? "";
}

/* ============================================================================
 * BarLegendSwatch — draws the *actual* bar recipe (tinted body + saturated
 * leading edge) so the legend can never drift from what is painted.
 * ========================================================================== */

function BarLegendSwatch({ hue, label }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="inline-block h-3 w-4 rounded-[2px]"
        style={{
          background: `color-mix(in srgb, ${hue} ${SPAN_TINT_PCT}%, var(--bg-secondary))`,
          boxShadow: `inset 3px 0 0 0 ${hue}`,
        }}
      />
      <span>{label}</span>
    </span>
  );
}

/* ============================================================================
 * CalendarView — multi-day spanning tiles across all item kinds.
 * ========================================================================= */

function WeekColumns({ days, items, goals, onSelectDay, onSelectItem }) {
  const goalById = new Map((goals || []).map((g) => [g.id, g]));
  const tasksByDay = new Map();
  for (const it of items) {
    if (it.kind !== "task" || !it.date) continue;
    const k = fmtIso(startOfDay(it.date));
    const arr = tasksByDay.get(k) || [];
    arr.push(it);
    tasksByDay.set(k, arr);
  }
  return (
    <div data-testid="week-columns" className="grid grid-cols-1 sm:grid-cols-7 gap-2">
      {(days || []).map((d) => {
        const k = fmtIso(startOfDay(d));
        const tasks = tasksByDay.get(k) || [];
        return (
          <div
            key={k}
            className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-2 min-h-[140px] flex flex-col"
          >
            <button type="button" onClick={() => onSelectDay?.(d)} className="mb-2 text-left">
              <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
                {WEEKDAYS[d.getDay()]}
              </span>
              <span className="ml-1.5 text-[13px] font-semibold tabular-nums text-[var(--text-primary)]">
                {d.getDate()}
              </span>
            </button>
            <div className="space-y-1 flex-1">
              {tasks.map((t) => {
                const g = goalById.get(t.goalId);
                const fulfils = (t.note || "")
                  .replace(/^Fulfils\s*/, "")
                  .split("·")[0]
                  .replace(/[“”"]/g, "")
                  .trim();
                return (
                  <button
                    key={t.id}
                    type="button"
                    data-testid={`week-task-${t.id}`}
                    onClick={() => onSelectItem?.(t)}
                    className="w-full text-left rounded-md bg-[var(--bg-tertiary)] px-2 py-1 transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_12%,var(--bg-tertiary))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  >
                    <div className={`text-[11px] leading-snug truncate ${t.status === "done" ? "line-through text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
                      {t.title}
                    </div>
                    <div className="text-[10px] leading-snug text-[var(--text-muted)] truncate">
                      {g ? g.title : ""}
                      {fulfils ? ` › ${fulfils}` : ""}
                    </div>
                  </button>
                );
              })}
              {tasks.length === 0 && <div className="text-[10px] text-[var(--text-muted)]">—</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CalendarView({
  allItems,
  cards,
  planItems = [],
  blocks = [],
  goals,
  milestones,
  commitments,
  blockers,
  today,
  span,
  setSpan,
  anchor,
  setAnchor,
  openChat,
  onSelectItem,
  onPrefill,
  onSelectDay,
  onSelectSlot,
}) {
  const preset = CAL_SPANS.find((s) => s.key === span) || CAL_SPANS[2];
  const days = preset.days;

  const { days: dayList, cells, itemsByDay } = useMemo(() => {
    const start =
      span === "week"
        ? startOfWeek(anchor)
        : span === "month"
        ? startOfMonth(anchor)
        : anchor;
    const daysArr = [];
    for (let i = 0; i < days; i++) daysArr.push(addDays(start, i));
    const end = addDays(start, days);

    const cellsArr = [];
    if (span === "week" || span === "month" || span === "quarter") {
      const padStart = start.getDay() === 0 ? 6 : start.getDay() - 1;
      for (let i = padStart; i > 0; i--) cellsArr.push({ date: addDays(start, -i), inSpan: false });
      daysArr.forEach((d) => cellsArr.push({ date: d, inSpan: true }));
      while (cellsArr.length % 7 !== 0) {
        const last = cellsArr[cellsArr.length - 1].date;
        cellsArr.push({ date: addDays(last, 1), inSpan: false });
      }
    } else {
      daysArr.forEach((d) => cellsArr.push({ date: d, inSpan: true }));
    }

    const itemsIdx = {};
    allItems.forEach((it) => {
      if (!it) return;
      const rawStart = it.start || it.date;
      const rawEnd = it.end || it.date;
      if (!rawStart && !rawEnd) return;
      const s = startOfDay(rawStart || rawEnd);
      const e = startOfDay(rawEnd || rawStart);
      if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime())) return;
      const cur = new Date(s);
      while (cur <= e) {
        const key = fmtIso(cur);
        (itemsIdx[key] = itemsIdx[key] || []).push(it);
        cur.setDate(cur.getDate() + 1);
      }
    });

    return { days: daysArr, cells: cellsArr, itemsByDay: itemsIdx };
  }, [allItems, anchor, days, span]);

  /* For week/month/quarter: render spanning tiles in a grid (lanes per week).
     For day: render a vertical list of items for that single day.
     For year: render the same lane-per-week grid laid out as 4
     quarter-columns (Iteration 7 — was a separate bar-chart). */
  const year = anchor.getFullYear();

  const weeks = useMemo(() => {
    const w = [];
    for (let i = 0; i < cells.length; i += 7) w.push(cells.slice(i, i + 7));
    return w;
  }, [cells]);

  // The plan's own targets for the zoomed-out spans: WEEKLY for the 3-month
  // view, MONTHLY (milestones) for the year view — not an aggregation of the
  // daily tasks.
  const planTargets = useMemo(() => {
    const colorByGoal = new Map((goals || []).map((g, i) => [g.id, GOAL_PALETTE[i % GOAL_PALETTE.length]]));
    const mk = (p, glyph) => {
      const goal = (goals || []).find((g) => g.id === p.goal_id);
      const when =
        p.horizon === "monthly"
          ? p.due_date || ""
          : p.start_date && p.end_date
          ? `${p.start_date} – ${p.end_date}`
          : p.due_date || "";
      return {
        id: p.id,
        item: { ...p, kind: "plan", title: p.title },
        title: p.title,
        glyph,
        goalTitle: goal?.title || "",
        color: colorByGoal.get(p.goal_id) || GOAL_PALETTE[0],
        phase: p.phase || "",
        hours: p.horizon === "weekly" && p.weekly_hours ? `${p.weekly_hours}h/wk` : "",
        when,
        date: p.due_date
          ? new Date(`${String(p.due_date).slice(0, 10)}T00:00:00`)
          : p.start_date
          ? new Date(`${String(p.start_date).slice(0, 10)}T00:00:00`)
          : null,
      };
    };
    return {
      weekly: planItems.filter((p) => p.horizon === "weekly").map((p) => mk(p, "▤")),
      monthly: planItems.filter((p) => p.horizon === "monthly").map((p) => mk(p, "◆")),
    };
  }, [planItems, goals]);

  const tracksByWeek = useMemo(() => {
    return weeks.map((week) => {
      if (!week || !Array.isArray(week) || week.length === 0) {
        return { tracks: [], maxLanes: 1 };
      }
      const firstValidCell = week.find((c) => c?.date);
      const lastValidCell = [...week].reverse().find((c) => c?.date);
      if (!firstValidCell?.date || !lastValidCell?.date) {
        return { tracks: [], maxLanes: 1 };
      }
      const weekStart = week[0]?.date || firstValidCell.date;
      const weekEnd = addDays(week[6]?.date || lastValidCell.date, 1);
      const tracks = [];
      allItems.forEach((it) => {
        if (!it) return;
        const rawStart = it.start || it.date;
        const rawEnd = it.end || it.date;
        if (!rawStart && !rawEnd) return;
        const s = startOfDay(rawStart || rawEnd);
        const e = startOfDay(rawEnd || rawStart);
        if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime())) return;
        if (e < weekStart || s >= weekEnd) return;
        const segStart = s < weekStart ? weekStart : s;
        const lastCellDate = week[6]?.date || lastValidCell.date;
        const segEnd = e >= weekEnd ? addDays(lastCellDate, 1) : addDays(e, 1);
        let startCol = 1;
        let endCol = 7;
        for (let i = 0; i < 7; i++) {
          const cDate = week[i]?.date;
          if (cDate && cDate >= segStart) { startCol = i + 1; break; }
        }
        for (let i = 6; i >= 0; i--) {
          const cDate = week[i]?.date;
          if (cDate && cDate < segEnd) { endCol = i + 1; break; }
        }
        tracks.push({ item: it, startCol, endCol, lane: -1 });
      });
      /* Greedy lane assignment per week, sorted by start then length. */
      tracks.sort((a, b) => {
        if (a.startCol !== b.startCol) return a.startCol - b.startCol;
        return (b.endCol - b.startCol) - (a.endCol - a.startCol);
      });
      const laneEnds = [];
      tracks.forEach((t) => {
        let placed = false;
        for (let i = 0; i < laneEnds.length; i++) {
          if (laneEnds[i] < t.startCol) {
            laneEnds[i] = t.endCol;
            t.lane = i;
            placed = true;
            break;
          }
        }
        if (!placed) {
          t.lane = laneEnds.length;
          laneEnds.push(t.endCol);
        }
      });
      return { tracks, maxLanes: Math.max(laneEnds.length, 1) };
    });
  }, [weeks, allItems]);


  
  if (allItems.length === 0) {
    return <CalendarEmptyState onAsk={openChat || onPrefill} />;
  }

  // Day span → hour grid when the user has a timetable, else the default day.
  if (span === "day" && blocks.length > 0) {
    return (
      <HourGrid
        days={[startOfDay(anchor)]}
        blocks={blocks}
        cards={cards || []}
        onSelectItem={onSelectItem}
        onSelectSlot={onSelectSlot}
      />
    );
  }

  // Week span → hour grid when the timetable is planned, else 7 day columns.
  if (span === "week") {
    if (blocks.length > 0) {
      return (
        <HourGrid
          days={dayList}
          blocks={blocks}
          cards={cards || []}
          onSelectItem={onSelectItem}
          onSelectSlot={onSelectSlot}
        />
      );
    }
    return (
      <CardsGrid
        days={dayList}
        cards={cards || []}
        onSelectDay={onSelectDay}
        onSelectItem={onSelectItem}
        minHeight={200}
      />
    );
  }

  // Month span → Google-Calendar month: a weekday header + one 7-day card row
  // per week (the `weeks` memo already pads to whole Mon–Sun rows).
  if (span === "month") {
    return (
      <div className="space-y-2">
        <WeekdayHeader />
        <div className="space-y-px">
          {weeks.map((week, i) => (
            <CardsGrid
              key={i}
              days={week.map((c) => c.date)}
              cards={cards || []}
              onSelectDay={onSelectDay}
              onSelectItem={onSelectItem}
              minHeight={120}
            />
          ))}
        </div>
      </div>
    );
  }

  // 3-month span → a proper grid of week cells (Week 1 … N).
  if (span === "quarter") {
    return <WeekGrid items={planTargets.weekly} onSelectItem={onSelectItem} />;
  }
  // Year span → a Jan … Dec grid; each month cell lists its milestones.
  if (span === "year") {
    return <MonthGrid year={anchor.getFullYear()} cards={planTargets.monthly} onSelectItem={onSelectItem} />;
  }

  /* === Year view (Iteration 7 — Ask 3) ===
   * Same lane-per-week pattern as Quarter, laid out as 4 quarter-columns
   * side by side for ~52 weeks. The previous bar-chart (one column per
   * month, stacked blocks in a 220px plot) read nothing like the
   * Month/Week/3-month views — different shape, different density, the
   * items-as-cells metaphor broke. Here every item renders the same way
   * regardless of span: a status-coloured bar with a left/right position
   * derived from its actual day-of-week span within the row.
   *
   * Layout:
   *   - 4 quarter-columns × 13 week-rows ≈ 52 rows
   *   - Each row is its own 7-day cell grid; bar's offset/width = its
   *     Mon..Sun position
   *   - Today row is accent-highlighted (matches Quarter's accent ring)
   */
  if (span === "year") {
    const yearStart = new Date(anchor.getFullYear(), 0, 1);
    const yearEnd = new Date(anchor.getFullYear() + 1, 0, 1);
    const quarters = [
      { label: "Q1 (Jan – Mar)", start: new Date(anchor.getFullYear(), 0, 1) },
      { label: "Q2 (Apr – Jun)", start: new Date(anchor.getFullYear(), 3, 1) },
      { label: "Q3 (Jul – Sep)", start: new Date(anchor.getFullYear(), 6, 1) },
      { label: "Q4 (Oct – Dec)", start: new Date(anchor.getFullYear(), 9, 1) },
    ];

    const buildQuarterRows = (qStart) => {
      const rows = [];
      let cursor = startOfWeek(qStart);
      let i = 0;
      // 14 weeks covers the 13 it could land in for the latest quarter
      while (cursor < yearEnd && i < 14) {
        const rowEnd = addDays(cursor, 7);
        if (cursor >= qStart && cursor < addDays(qStart, 92)) {
          const overlaps = allItems.filter((it) => {
            if (!it) return false;
            const s = startOfDay(it.start || it.date);
            const e = startOfDay(it.end || it.date);
            if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime())) return false;
            return e >= cursor && s < rowEnd;
          });
          rows.push({ start: cursor, end: addDays(cursor, 6), items: overlaps });
        }
        cursor = rowEnd;
        i++;
      }
      return rows;
    };

    const rowHeight = 26;
    return (
      <div className="space-y-3">
        <div
          className="rounded-lg border border-[var(--border-accent)] overflow-hidden"
          style={{ background: "var(--bg-primary)" }}
        >
          {/* B4#7 — below md each quarter column is ~86px wide, leaving
              ~6px/day in the week rows. Scroll horizontally on phones
              (620px floor) instead of crushing; md+ keeps the 4-up grid. */}
          <div className="overflow-x-auto md:overflow-visible">
          <div className="min-w-[620px] md:min-w-0">
          <div
            className="font-medium grid grid-cols-4 text-xs text-[var(--text-muted)] border-b border-[var(--border-accent)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)]"
          >
            {quarters.map((q, qi) => (
              <div key={qi} className="px-2 py-2 text-center select-none border-r last:border-r-0 border-[var(--border-accent)]">
                {q.label}
              </div>
            ))}
          </div>
          <div
            className="grid grid-cols-4 divide-x divide-[var(--border-accent)]"
            role="rowgroup"
          >
            {quarters.map((q, qi) => {
              const rows = buildQuarterRows(q.start);
              return (
                <div key={qi} role="rowgroup" data-testid={`timeline-cal-year-col-${qi}`}>
                  {rows.map((r, ri) => {
                    const isToday = today >= r.start && today < addDays(r.start, 7);
                    const wkLabel = `${MONTHS_SHORT[r.start.getMonth()]} ${r.start.getDate()}`;
                    return (
                      <div
                        key={ri}
                        data-testid={`timeline-cal-year-row-${qi}-${ri}`}
                        className="grid grid-cols-[44px_1fr] border-b last:border-b-0 border-[var(--border)]"
                        style={{ minHeight: `${rowHeight}px`, background: isToday ? "color-mix(in srgb, var(--accent) 8%, var(--bg-primary))" : undefined }}
                      >
                        <div className={`px-1.5 py-1 text-xs font-medium text-[var(--text-muted)] flex items-center ${isToday ? "text-[var(--accent)] font-semibold" : ""}`}>
                          {wkLabel}
                        </div>
                        <div className="relative px-1 py-0.5" style={{ minHeight: `${rowHeight}px` }}>
                          <div className="grid grid-cols-7 h-full pointer-events-none absolute inset-0">
                            {Array.from({ length: 7 }).map((_, idx) => (
                              <div
                                key={idx}
                                className={`${idx === 0 ? "" : "border-l border-[var(--border)]"}`}
                                aria-hidden="true"
                              />
                            ))}
                          </div>
                          <div className="relative space-y-0.5">
                            {r.items.length === 0 ? null : (
                              r.items.slice(0, 2).map((it) => {
                                const s = startOfDay(it.start || it.date);
                                const e = startOfDay(it.end || it.date);
                                const segStart = s < r.start ? r.start : s;
                                const segEnd = e > r.end ? r.end : e;
                                const offset = (segStart.getTime() - r.start.getTime()) / (7 * DAY_MS);
                                const width = Math.max(
                                  0.05,
                                  (segEnd.getTime() - segStart.getTime() + DAY_MS) / (7 * DAY_MS),
                                );
                                const paint = barPaint(it, "var(--bg-primary)");
                                return (
                                  <button
                                    key={`${it.kind}-${it.id}`}
                                    type="button"
                                    data-testid={`timeline-cal-year-bar-${it.kind}-${it.id}`}
                                     onClick={() => onSelectItem?.(it)}
                                    title={it.title}
                                    aria-label={`${it.kind}: ${it.title}`}
                                    className="group block min-h-11 rounded-[2px] text-left text-xs px-1 truncate hover:brightness-110 transition-[filter] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                                    style={{
                                      marginLeft: `${offset * 100}%`,
                                      width: `${width * 100}%`,
                                      background: paint.background,
                                      boxShadow: paint.boxShadow,
                                      color: paint.color,
                                      paddingLeft: paint.stripe ? 8 : undefined,
                                    }}
                                  >
                                    {it.title}
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
          <span>
            <span className="text-[var(--text-secondary)]">← →</span> year, {" "}
            <span className="text-[var(--text-secondary)]">T</span> today, {" "}
            <span className="text-[var(--text-secondary)]">1–5</span> change span
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: "var(--accent)" }}
              />
              <span>goals</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="text-[var(--accent)]">▸</span>
              <span>commitments</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="text-[var(--warning)]">◆</span>
              <span>milestones</span>
            </span>
            <BarLegendSwatch hue="var(--success)" label="on track" />
            <BarLegendSwatch hue="var(--warning)" label="in progress" />
            <BarLegendSwatch hue="var(--danger)" label="overdue" />
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-4 rounded-[2px] bg-[var(--warning)]"
              />
              <span>single day</span>
            </span>
          </span>
        </div>
      </div>
    );
  }

  /* === Quarter view (Issue 4) — week-grain quantization ===
   * 90 days / 7 = ~13 weeks. The previous code dropped the user into the
   * same 7-day grid used by the week/month view, which made "3 months"
   * indistinguishable from "month" except for being scrolled further.
   * The point of picking 3 months is to see rhythm across weeks, not to
   * read individual days. So: one row per ISO week (Mon-anchored… matches
   * the existing week start), a single lane, each item rendered as a bar
   * that spans the whole 7-column row and is colored by status. The
   * bar's left/right within the row is its actual day-of-week span.
   * Hover shows the title; click opens a scoped chat. */
  if (span === "quarter") {
    const quarterStart = startOfDay(anchor);
    const quarterEnd = addDays(quarterStart, 90);
    const rows = [];
    let cursor = startOfWeek(quarterStart);
    let i = 0;
    while (cursor < quarterEnd && i < 16) {
      const rowEnd = addDays(cursor, 7);
      const overlaps = allItems.filter((it) => {
        if (!it) return false;
        const s = startOfDay(it.start || it.date);
        const e = startOfDay(it.end || it.date);
        if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime())) return false;
        return e >= cursor && s < rowEnd;
      });
      rows.push({ start: cursor, end: addDays(cursor, 6), items: overlaps });
      cursor = rowEnd;
      i++;
    }
    const rowHeight = 30;
    return (
      <div className="space-y-3">
        <div
          className="rounded-lg border border-[var(--border-accent)] overflow-hidden"
          style={{ background: "var(--bg-primary)" }}
        >
          <div
            className="font-medium grid grid-cols-[88px_1fr] text-[12px] text-[var(--text-muted)] border-b border-[var(--border-accent)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)]"
          >
            <div className="px-2 py-2">Week</div>
            <div className="px-2 py-2">Items (status-colored bars)</div>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {rows.map((r, ri) => {
              const wkLabel = `${MONTHS_SHORT[r.start.getMonth()]} ${r.start.getDate()}`;
              return (
                <div
                  key={ri}
                  data-testid={`timeline-cal-quarter-row-${ri}`}
                  className="grid grid-cols-[88px_1fr]"
                  style={{ minHeight: `${rowHeight}px` }}
                >
                  <div className="font-medium px-2 py-2 text-[12px] text-[var(--text-muted)] border-r border-[var(--border-accent)] bg-[color-mix(in_srgb,var(--bg-secondary)_30%,transparent)] flex items-center">
                    {wkLabel}
                  </div>
                  <div
                    className="relative px-2 py-1.5"
                    style={{ minHeight: `${rowHeight}px` }}
                  >
                    {/* 7 day-grid guides so the user can read "Mon–Sun". */}
                    <div className="grid grid-cols-7 h-full pointer-events-none absolute inset-0 px-2">
                      {Array.from({ length: 7 }).map((_, idx) => (
                        <div
                          key={idx}
                          className={`border-l ${idx === 0 ? "border-transparent" : "border-[var(--border)]"}`}
                          aria-hidden="true"
                        />
                      ))}
                    </div>
                    <div className="relative space-y-1">
                      {r.items.length === 0 ? (
                        <span className="text-[12px] text-[var(--text-muted)] italic">nothing scheduled</span>
                      ) : (
                        r.items.slice(0, 4).map((it) => {
                          const s = startOfDay(it.start || it.date);
                          const e = startOfDay(it.end || it.date);
                          const segStart = s < r.start ? r.start : s;
                          const segEnd = e > r.end ? r.end : e;
                          const offset = (segStart.getTime() - r.start.getTime()) / (7 * 86400000);
                          const width = Math.max(
                            0.05,
                            (segEnd.getTime() - segStart.getTime() + 86400000) / (7 * 86400000),
                          );
                          const paint = barPaint(it, "var(--bg-primary)");
                          return (
                            <button
                              key={`${it.kind}-${it.id}`}
                              type="button"
                              data-testid={`timeline-cal-quarter-bar-${it.kind}-${it.id}`}
                              onClick={() => onSelectItem?.(it)}
                              title={it.title}
                              aria-label={`${it.kind}: ${it.title}`}
                              className="group block min-h-11 rounded-[3px] text-left text-[12px] px-2 truncate hover:brightness-110 transition-[filter] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                              style={{
                                marginLeft: `${offset * 100}%`,
                                width: `${width * 100}%`,
                                background: paint.background,
                                boxShadow: paint.boxShadow,
                                color: paint.color,
                                // Keep the label off the accent stripe.
                                paddingLeft: paint.stripe ? 10 : undefined,
                              }}
                            >
                              {itemKindGlyph(it.kind)}
                              {it.title}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[12px] text-[var(--text-muted)]">
            ← → 3 months, T today, 1–5 change span
          </div>
          <div className="text-[12px] text-[var(--text-muted)] flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: "var(--accent)" }}
              />
              <span>goals</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="text-[var(--accent)]">▸</span>
              <span>commitments</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="text-[var(--warning)]">◆</span>
              <span>milestones</span>
            </span>
            <BarLegendSwatch hue="var(--success)" label="on track" />
            <BarLegendSwatch hue="var(--warning)" label="in progress" />
            <BarLegendSwatch hue="var(--danger)" label="overdue" />
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-4 rounded-[2px] bg-[var(--warning)]"
              />
              <span>single day</span>
            </span>
          </div>
        </div>
      </div>
    );
  }

  /* === Day view === */
  if (span === "day") {
    return (
      <div className="mx-auto max-w-md">
        <CardsGrid
          days={[anchor]}
          cards={cards || []}
          onSelectDay={onSelectDay}
          onSelectItem={onSelectItem}
          minHeight={180}
          columns={1}
        />
      </div>
    );
  }

  // Lane height for the week/month grids. Must fit a full tap target:
  // CalendarTile is min-h-11 (44px) and its grid item carries 2px
  // vertical padding on each side, so 44 + 4 = 48. At the old 26px the
  // 44px tiles overflowed the lane and painted over the next week's
  // day-number row.
  const baseBarHeight = 48;

  return (
    <div className="space-y-3">
      <div
        className="rounded-lg border border-[var(--border-accent)] overflow-hidden shadow-[0_1px_0_color-mix(in_srgb,var(--accent)_15%,transparent)]"
        style={{ background: "var(--bg-primary)" }}
      >
        <div
          className="font-medium grid grid-cols-7 text-xs text-[var(--text-muted)] border-b border-[var(--border-accent)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)]"
        >
          {DOW.map((d, i) => (
            <div key={d} className="px-2 py-2 text-center select-none">
              <span className="hidden sm:inline">{DOW[i]}</span>
              <span className="sm:hidden">{DOW_SHORT[i]}</span>
            </div>
          ))}
        </div>

        <div className="divide-y divide-[var(--border)]">
          {weeks.map((week, wi) => {
            const weekTrackInfo = tracksByWeek[wi] || { tracks: [], maxLanes: 1 };
            const { tracks, maxLanes } = weekTrackInfo;
            const gridStyle = {
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gridTemplateRows: `auto repeat(${maxLanes}, ${baseBarHeight}px)`,
            };
            return (
              <div key={wi} className="grid relative" style={gridStyle}>
                {/* Column guides span the FULL row height, including the
                    tile lanes. Previously only the day-number row (gridRow
                    1) drew a right border, so the day columns visually
                    dissolved underneath any spanning tile. */}
                <div
                  aria-hidden="true"
                  className="absolute inset-0 grid grid-cols-7 pointer-events-none"
                >
                  {Array.from({ length: 7 }).map((_, ci) => (
                    <div
                      key={ci}
                      className={ci === 6 ? "" : "border-r border-[var(--border-accent)]"}
                    />
                  ))}
                </div>
                {week.map((cell, ci) => {
                  if (!cell || !cell.date) {
                    return (
                      <div
                        key={ci}

                        className="relative px-1.5 pt-1 pb-1 min-h-[36px] opacity-70"
                        style={{ gridColumn: ci + 1, gridRow: 1 }}
                      />
                    );
                  }
                  const isToday = sameDay(cell.date, today);
                  const key = fmtIso(cell.date);
                  const count = (itemsByDay[key] || []).length;
                  return (
                    <div
                      key={ci}
                      role={onSelectDay ? "button" : undefined}
                      tabIndex={onSelectDay ? 0 : undefined}
                      onClick={onSelectDay ? () => onSelectDay(cell.date) : undefined}
                      onKeyDown={onSelectDay ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectDay(cell.date); } } : undefined}
                      aria-label={`${MONTHS_FULL[cell.date.getMonth()]} ${cell.date.getDate()}${isToday ? ", today" : ""}${count ? `, ${count} item${count === 1 ? "" : "s"}` : ""}${onSelectDay ? " — open day planner" : ""}`}
                      className={[
                        "relative px-1.5 pt-1 pb-1 min-h-[36px]",
                        cell.inSpan ? "" : "opacity-70",
                        onSelectDay ? "cursor-pointer hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]" : "",
                        isToday
                          ? "ring-1 ring-inset ring-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg-primary))]"
                          : "",
                      ].join(" ")}
                      style={{ gridColumn: ci + 1, gridRow: 1 }}
                    >
                      <div className="flex items-start justify-between">
                        <span
                          className={[
                            "text-xs tabular-nums leading-none",
                            isToday ? "font-bold text-[var(--accent)]" : "text-[var(--text-secondary)]",
                          ].join(" ")}
                        >
                          {cell.date.getDate()}
                        </span>
                      </div>
                    </div>
                  );
                })}

                {tracks.map((t) => (
                  <div
                    key={`${t.item?.kind || "item"}-${t.item?.id || Math.random()}-${wi}`}
                    style={{
                      gridColumn: `${t.startCol} / ${t.endCol + 1}`,
                      gridRow: t.lane + 2,
                      padding: "2px 4px",
                      zIndex: 1,
                    }}
                  >
                    {t.item && <CalendarTile item={t.item} today={today} onSelectItem={onSelectItem} />}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
        <span>
          <span className="text-[var(--text-secondary)]">← →</span> {span === "week" ? "week" : span === "month" ? "month" : "3 months"}, {" "}
          <span className="text-[var(--text-secondary)]">T</span> today, {" "}
          <span className="text-[var(--text-secondary)]">1–5</span> change span
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: "var(--accent)" }}
            />
            <span>goals</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="text-[var(--accent)]">▸</span>
            <span>commitments</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="text-[var(--warning)]">◆</span>
            <span>milestones</span>
          </span>
          <span>— click a tile for details, then edit with the coach</span>
        </span>
      </div>
    </div>
  );
}

function CalendarTile({ item, today, onSelectItem }) {
  if (!item) return null;
  // Iteration 5 — color is now status-driven (green/red/yellow/grey)
  // so the calendar reads as on-track vs overdue at a glance.
  const color = statusColor(item);

  const isDone = (item.status || "").toLowerCase() === "done";
  const rawDate = item.end || item.date || item.start;
  const itemDate = rawDate ? new Date(rawDate) : null;
  const isPast = itemDate && !isNaN(itemDate.getTime()) ? itemDate < today && !isDone : false;
  const spanDays = item.start && item.end && !isNaN(new Date(item.start).getTime()) && !isNaN(new Date(item.end).getTime())
    ? Math.max(1, Math.round((startOfDay(item.end) - startOfDay(item.start)) / DAY_MS) + 1)
    : 1;

  const tileTestId = `timeline-cal-tile-${item.kind}-${item.id}`;
  // Spanning items get an explicit "Sep 30 – Dec 28" range in the tooltip
  // so the bar's width is legible as a duration, not just a block.
  const range =
    spanDays > 1 && item.start && item.end
      ? `, ${fmtDay(startOfDay(item.start))} – ${fmtDay(startOfDay(item.end))}`
      : "";
  const inferredNote = item.inferredSpan ? ", estimated from horizon" : "";
  const tip = item.kind === "goal"
    ? `Goal: ${item.title}${item.horizon ? `, ${HORIZON_LABEL[item.horizon] || ""}` : ""}${range}${inferredNote}`
    : item.kind === "milestone"
    ? `Milestone: ${item.title}${item.goalTitle ? `, ${item.goalTitle}` : ""}`
    : item.kind === "commitment"
    ? `Commitment: ${item.title}${item.goalTitle ? `, ${item.goalTitle}` : ""}`
    : `Blocker: ${item.title}`;

  // Iteration 5 (Issue 7+8) — thread scoped chat context. No more
  // hardcoded "Let's work on my goal: …" prefills; the user types
  // their own intent in an empty chat that already has the entity's
  // title + kind + id pinned in the conversation.
  const onActivate = () => onSelectItem?.(item);

  // Iteration 7 (consistency fix) — Month/Week now use the same
  // barPaint() recipe as 3-Months/Year. Previously CalendarTile
  // painted solid-saturated backgrounds for multi-day bars, while
  // the 3-Months/Year path used the tinted-body-with-leading-edge
  // treatment — same item, different look across spans, which
  // read as a bug ("is this a different goal?"). barPaint handles
  // the span logic: ≤2-day items get the solid single-day fill
  // (unchanged), longer items get the tinted body + saturated
  // leading edge.
  const paint = barPaint(item, "var(--bg-primary)");

  if (item.kind === "blocker") {
    return (
      <button
        type="button"
        data-testid={tileTestId}
        onClick={onActivate}
        title={tip}
        aria-label={tip}
        className="min-h-11 w-full rounded-[3px] flex items-center gap-1.5 px-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-primary)] transition-all hover:brightness-110"
        style={{
          background: paint.background,
          // Keep the diagonal-stripe treatment that flags blockers as
          // "active constraint" — the leading-edge stripe alone reads
          // like a milestone. Combines the tint base with a repeating
          // stripe pattern on top.
          backgroundImage: `repeating-linear-gradient(45deg, ${color}, ${color} 4px, color-mix(in srgb, ${color} 60%, var(--bg-primary)) 4px, color-mix(in srgb, ${color} 60%, var(--bg-primary)) 8px)`,
          color: paint.color,
          opacity: isPast ? 0.85 : 1,
          fontWeight: 500,
          minHeight: "44px",
          // Pad the label off the leading-edge stripe (if any).
          paddingLeft: paint.stripe ? 10 : undefined,
        }}
      >
        <AlertOctagon size={10} aria-hidden="true" />
        <span className="truncate">{item.title}</span>
      </button>
    );
  }

  if (item.kind === "milestone" && spanDays === 1) {
    return (
      <button
        type="button"
        data-testid={tileTestId}
        onClick={onActivate}
        title={tip}
        aria-label={tip}
        className="min-h-11 w-full rounded-[3px] px-1.5 text-xs text-[var(--bg-primary)] flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-primary)] transition-all hover:brightness-110"
        style={{ background: color, opacity: isDone ? 0.55 : 1, fontWeight: 500, minHeight: "44px" }}
      >
        <Target size={9} aria-hidden="true" />
        <span className="truncate">{item.title}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid={tileTestId}
      onClick={onActivate}
      title={tip}
      aria-label={tip}
      className="group min-h-11 w-full text-left rounded-[3px] px-1.5 truncate text-xs transition-all hover:brightness-110 hover:z-10 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg-primary)]"
      style={{
        background: paint.background,
        boxShadow: paint.boxShadow,
        color: paint.color,
        opacity: isDone ? 0.55 : isPast ? 0.85 : 1,
        fontWeight: 500,
        minHeight: "44px",
        // Pad the label off the leading-edge stripe (if any).
        paddingLeft: paint.stripe ? 10 : undefined,
      }}
    >
      <span className="block truncate">
        {item.kind === "commitment" ? "▸ " : item.kind === "milestone" ? "◆ " : ""}{item.title}
      </span>
    </button>
  );
}

function CalendarMiniItem({ item, today }) {
  const color = item.kind === "goal"
    ? (HORIZON_COLOR[item.horizon] || "var(--accent)")
    : item.kind === "milestone"
    ? "var(--warning)"
    : item.kind === "commitment"
    ? "var(--accent)"
    : "var(--danger)";

  return (
    <div className="flex items-center gap-1.5 text-xs leading-tight">
      <span className="w-1 h-1 rounded-full shrink-0" style={{ background: color }} />
      <span className="truncate text-[var(--text-secondary)]">{item.title}</span>
    </div>
  );
}

function CalendarDayItem({ item, today, onSelectItem }) {
  // Iteration 5 (Issue 2-3) — status color
  const color = statusColor(item);

  // Iteration 5 (Issue 7+8) — scoped chat, no hardcoded prefill
  const onActivate = () => onSelectItem?.(item);

  return (
    <button
      type="button"
      onClick={onActivate}
      className="min-h-11 w-full flex items-center gap-3 p-2 rounded border border-[var(--border)] hover:border-[var(--border-accent)] hover:bg-[var(--bg-tertiary)] transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{ background: "var(--bg-primary)" }}
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="font-medium text-xs text-[var(--text-muted)] shrink-0">
        {item.kind}
      </span>
      <span className="truncate text-[var(--text-primary)] text-[13px]">{item.title}</span>
    </button>
  );
}

function TimelineItemDetailsDialog({ item, state, onClose, onEdit, onAddBlocker, onAddCommitment, onToggle }) {
  if (!item) return null;
  const goalId = item.kind === "goal" ? item.id : item.goal_id || item.goalId;
  const goal = (state?.goals || []).find((candidate) => candidate.id === goalId)
    || (state?.goals || []).find((candidate) => candidate.title === (item.goal_title || item.goalTitle));
  const milestones = (state?.milestones || []).filter(
    (milestone) => goal && (milestone.goal_id === goal.id || milestone.goal_title === goal.title),
  );
  const commitments = (state?.commitments || []).filter(
    (commitment) => goal && (commitment.goal_id === goal.id || commitment.goal_title === goal.title),
  );
  const phases = Object.entries(goal?.phase_objectives || {});
  const dateLabel = (value) => {
    const date = value instanceof Date ? value : parse(String(value || ""));
    return date ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  };
  const dateRange = item.kind === "goal"
    ? [dateLabel(item.start), dateLabel(item.end)].filter(Boolean).join(" – ")
    : item.kind === "blocker"
    ? [dateLabel(item.start), dateLabel(item.end)].filter(Boolean).join(" – ")
    : dateLabel(item.date || item.target_date || item.due);

  const isTask = item.kind === "task" || item.kind === "plan";
  const done = (item.status || "").toLowerCase() === "done";
  const doneLabel = item.kind === "commitment" ? "commitment" : isTask ? "task" : "item";
  // For a task the middle of the hierarchy is the commitment it advances;
  // for a commitment the middle is itself.
  const commitmentTitle = isTask
    ? (item.commitment || (item.note || "").replace(/^Fulfils\s*/, "").split("·")[0].replace(/[“”"]/g, "").trim())
    : item.kind === "commitment"
    ? item.title || item.text
    : "";
  const fulfils = isTask
    ? (item.note || "").replace(/^Fulfils\s*/, "").split("·")[0].replace(/[“”"]/g, "").trim()
    : "";
  const hours = (() => {
    const m = (item.note || "").match(/([\d.]+)h/);
    if (m) return `${m[1]}h`;
    if (item.kind === "task" && item.start && item.end && item.start !== item.end) {
      const h = (startOfDay(item.end) - startOfDay(item.start)) / DAY_MS;
      return h > 0 ? `${h}d` : "";
    }
    return "";
  })();

  return (
    <CenteredDialog
      open={!!item}
      onClose={onClose}
      title={item.title || item.text || "Timeline item"}
      maxWidth="max-w-lg"
      testId="timeline-item-details"
    >
      <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
        {/* hierarchy — what this is, the commitment it advances, the goal */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <span aria-hidden="true" className="text-[var(--accent)]">
              {item.kind === "commitment" ? "⚑" : item.kind === "milestone" ? "◆" : item.kind === "blocker" ? "▲" : "○"}
            </span>
            {isTask ? "Task" : item.kind === "commitment" ? "Commitment" : item.kind === "milestone" ? "Milestone" : item.kind === "blocker" ? "Blocker" : "Item"}
          </div>
          {commitmentTitle && item.kind !== "commitment" && (
            <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <span aria-hidden="true" className="text-[var(--accent)]">⚑</span>
              Commitment: <span className="text-[var(--text-primary)]">{commitmentTitle}</span>
            </div>
          )}
          {(goal?.title || item.goalTitle || item.goal_title) && (
            <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <span aria-hidden="true" className="text-[var(--success)]">◉</span>
              Goal: <span className="text-[var(--text-primary)]">{goal?.title || item.goalTitle || item.goal_title}</span>
            </div>
          )}
          {fulfils && fulfils !== commitmentTitle && (
            <p className="text-[11px] text-[var(--text-muted)]">Achieves &ldquo;{fulfils}&rdquo;{hours ? ` · ${hours}` : ""}</p>
          )}
          {dateRange && <p className="text-xs font-mono text-[var(--text-muted)]">{dateRange}</p>}
        </div>

        {/* done checkbox — logs the item done */}
        {onToggle && (isTask || item.kind === "commitment" || item.kind === "milestone") && (
          <button
            type="button"
            data-testid="timeline-item-toggle-done"
            onClick={() => onToggle(item)}
            aria-pressed={done}
            className="flex w-full items-center gap-2.5 rounded-xl border border-[var(--border)] px-3 py-2.5 text-left text-sm hover:bg-[var(--bg-tertiary)]"
          >
            {done ? (
              <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--success)]" aria-hidden="true" />
            ) : (
              <Circle className="h-5 w-5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            )}
            <span className={done ? "text-[var(--text-muted)] line-through" : "text-[var(--text-primary)]"}>
              Mark this {doneLabel} as done
            </span>
          </button>
        )}

        {goal?.why && <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{goal.why}</p>}
        {goal?.next_action && (
          <p className="rounded-lg bg-[var(--bg-secondary)] p-3 text-sm text-[var(--text-primary)]">
            <span className="block text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">Next action</span>
            {goal.next_action}
          </p>
        )}
        {(item.phase) && (
          <p className="text-xs text-[var(--text-secondary)]">Phase: <span className="text-[var(--text-primary)]">{item.phase}</span></p>
        )}
        {item.kind === "blocker" && item.note && <p className="text-sm text-[var(--text-secondary)]">{item.note}</p>}
        {phases.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">Phases</h3>
            {phases.map(([name, objective]) => (
              <div key={name} className="rounded-lg border border-[var(--border)] px-3 py-2">
                <div className="text-xs font-semibold text-[var(--text-primary)]">{name}</div>
                <div className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{objective}</div>
              </div>
            ))}
          </section>
        )}
        {item.kind === "goal" && milestones.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">Milestones</h3>
            {milestones.map((milestone) => (
              <div key={milestone.id} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-[var(--text-primary)]">{milestone.title}</span>
                <span className="shrink-0 text-[var(--text-muted)]">{milestone.phase || ""}{milestone.target_date ? ` · ${milestone.target_date}` : ""}</span>
              </div>
            ))}
          </section>
        )}
        {item.kind === "goal" && commitments.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">Commitments</h3>
            {commitments.map((commitment) => (
              <div key={commitment.id} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-[var(--text-primary)]">{commitment.text}</span>
                <span className="shrink-0 text-[var(--text-muted)]">{commitment.due || "No date"}</span>
              </div>
            ))}
          </section>
        )}
        <button
          type="button"
          data-testid="timeline-item-edit-with-coach"
          onClick={onEdit}
          className="min-h-11 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--bg-primary)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" /> Edit with coach
        </button>
        {(onAddBlocker || onAddCommitment) && (
          <div className="flex gap-2">
            {onAddCommitment && (
              <button
                type="button"
                data-testid="timeline-item-add-commitment"
                onClick={onAddCommitment}
                className="min-h-11 flex-1 rounded-xl bg-[var(--bg-tertiary)] px-3 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Add commitment
              </button>
            )}
            {onAddBlocker && (
              <button
                type="button"
                data-testid="timeline-item-add-blocker"
                onClick={onAddBlocker}
                className="min-h-11 flex-1 rounded-xl bg-[var(--bg-tertiary)] px-3 text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Add blocker
              </button>
            )}
          </div>
        )}
      </div>
    </CenteredDialog>
  );
}

function CalendarEmptyState({ onAsk }) {
  return (
    <div
      data-testid="timeline-calendar-empty-state"
      className="flex flex-col items-center justify-center text-center px-6 py-16 rounded-2xl bg-[var(--bg-secondary)]"
    >
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
        style={{ background: "color-mix(in srgb, var(--accent) 15%, var(--bg-secondary))" }}
      >
        <CalendarClock size={22} className="text-[var(--accent)]" aria-hidden="true" />
      </div>
      <h3 className="font-display text-[18px] font-semibold text-[var(--text-primary)]">
        Nothing scheduled yet
      </h3>
      <p className="text-[13px] text-[var(--text-secondary)] mt-1.5 max-w-sm">
        Goals, milestones, and commitments will appear here as colored tiles across the days they cover.
      </p>
      {typeof onAsk === "function" && (
        // Iteration 5 (Issue 8) — empty-state CTA no longer pre-fills a
        // canned goal prompt. Opens the generic chat so the user can
        // describe whatever they actually want to talk about.
        <button
          type="button"
          data-testid="timeline-prefill-button"
          onClick={() =>
            onAsk("", {
              scope: "generic",
              kind: "plan_day",
              title: "Schedule my goals",
              helperText:
                "Goals, milestones, and commitments will appear here as colored tiles across the days they cover.",
            })
          }
          className="font-medium mt-4 inline-flex items-center gap-1.5 h-11 px-5 rounded-full text-sm font-semibold text-[var(--bg-primary)] hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)]"
          style={{ background: "var(--accent)" }}
        >
          <Sparkles size={14} aria-hidden="true" />
          Ask the coach
        </button>
      )}
    </div>
  );
}
