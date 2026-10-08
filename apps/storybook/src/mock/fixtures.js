/**
 * Seed data for the interactive playground, plus the mutations the mock
 * backend applies on write.
 *
 * Shapes are copied from the live contract, not invented: `state` matches
 * api/lib/dashboard-state.ts (built by state-builder.ts), `/memories` is
 * wrapped in `{ memories }`, `/chat/history` and `/audit` are bare arrays,
 * and `/motivation/recommend` reports `cache: "hit"` so the card doesn't poll
 * for 60s waiting on a "miss".
 *
 * Dates are relative to today so the Today / Timeline / overdue-milestone
 * surfaces are populated whenever you open the playground, not only on the
 * day these numbers were written.
 */

const dayOffset = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d;
};
const iso = (offset) => dayOffset(offset).toISOString();
const dateOnly = (offset) => iso(offset).slice(0, 10);
const now = () => new Date().toISOString();

let seq = 0;
const id = (prefix) => `${prefix}_${++seq}`;

/* ------------------------------------------------------------------ goals */

const GOAL_MVP = "goal_mvp";
const GOAL_RUN = "goal_run";
const GOAL_SPANISH = "goal_spanish";

const goals = [
  {
    id: GOAL_MVP,
    title: "Ship the MVP to 10 paying users",
    horizon: "quarterly",
    status: "active",
    why: "I want proof this is a real product before I quit my job.",
    next_action: "Write the onboarding checklist",
    target_date: dateOnly(60),
    start_date: dateOnly(-30),
    drift_status: null,
    weekly_hours: 15,
    phase_objectives: {},
    life_area: "career",
    sources: [],
  },
  {
    id: GOAL_RUN,
    title: "Run a half marathon under 2 hours",
    horizon: "monthly",
    status: "active",
    why: "I sit all day and it shows.",
    next_action: "Book the race entry",
    target_date: dateOnly(95),
    start_date: dateOnly(-20),
    drift_status: "behind",
    weekly_hours: 6,
    phase_objectives: {},
    life_area: "health",
    sources: [],
  },
  {
    id: GOAL_SPANISH,
    title: "Hold a 10-minute conversation in Spanish",
    horizon: "yearly",
    status: "paused",
    why: "Family trip next winter.",
    next_action: "Restart the Anki deck",
    target_date: dateOnly(220),
    start_date: dateOnly(-90),
    drift_status: null,
    weekly_hours: 3,
    phase_objectives: {},
    life_area: "personal",
    sources: [],
  },
];

const milestones = [
  {
    id: "ms_spec",
    title: "Draft the product spec",
    target_date: dateOnly(-3), // deliberately overdue — drives the Trackers
    goal_title: goals[0].title,
    status: "open",
    phase: "build",
    goal_id: GOAL_MVP,
  },
  {
    id: "ms_ten_users",
    title: "First 10 paying users",
    target_date: dateOnly(20),
    goal_title: goals[0].title,
    status: "open",
    phase: "launch",
    goal_id: GOAL_MVP,
  },
  {
    id: "ms_10k",
    title: "Run 10k without walking",
    target_date: dateOnly(11),
    goal_title: goals[1].title,
    status: "open",
    phase: "base",
    goal_id: GOAL_RUN,
  },
  {
    id: "ms_base",
    title: "Four weeks of consistent runs",
    target_date: dateOnly(-1),
    goal_title: goals[1].title,
    status: "done",
    phase: "base",
    goal_id: GOAL_RUN,
  },
];

const blockers = [
  {
    id: "blk_travel",
    user_id: "user_playground",
    title: "Family trip — no laptop",
    start_date: dateOnly(5),
    end_date: dateOnly(12),
    note: "Plan around this; nothing ships that week.",
    created_at: iso(-10),
  },
  {
    id: "blk_oncall",
    user_id: "user_playground",
    title: "On-call rotation",
    start_date: dateOnly(21),
    end_date: dateOnly(28),
    note: "Evenings are unreliable.",
    created_at: iso(-4),
  },
];

const planItems = [
  ["Write the onboarding checklist", -1, 1.5, "done"],
  ["Sketch the paywall screen", 0, 2, "open"],
  ["Draft pricing copy", 0, 1, "open"],
  ["Interview 2 users", 1, 2, "open"],
  ["Fix the billing webhook", 2, 3, "open"],
  ["Easy 5k", 0, 0.75, "open"],
  ["Interval session", 2, 1, "open"],
  ["Long run 12k", 4, 1.5, "open"],
  ["Review last week's plan", -2, 0.5, "done"],
  ["Read 20 pages", 3, 0.5, "open"],
  ["Ship the settings screen", 6, 4, "open"],
  ["Rest day", 5, 0, "open"],
].map(([title, offset, hours, status], i) => ({
  id: `pi_${i + 1}`,
  goal_id: i >= 5 && i <= 7 ? GOAL_RUN : GOAL_MVP,
  horizon: offset >= 5 ? "weekly" : "daily",
  phase: null,
  title,
  note: "",
  start_date: dateOnly(offset),
  end_date: dateOnly(offset),
  due_date: dateOnly(offset),
  weekly_hours: hours,
  status,
}));

const sources = [
  {
    id: "src_pdf",
    user_id: "user_playground",
    goal_id: GOAL_MVP,
    goal_title: goals[0].title,
    kind: "file",
    storage_path: "sources/notes.pdf",
    original_filename: "positioning-notes.pdf",
    content_type: "application/pdf",
    size: 184320,
    url: "",
    is_deleted: false,
    created_at: iso(-12),
  },
  {
    id: "src_link",
    user_id: "user_playground",
    goal_id: GOAL_MVP,
    goal_title: goals[0].title,
    kind: "link",
    storage_path: null,
    original_filename: null,
    content_type: null,
    size: null,
    url: "https://example.com/pricing-teardown",
    is_deleted: false,
    created_at: iso(-6),
  },
  {
    id: "src_photo",
    user_id: "user_playground",
    goal_id: GOAL_RUN,
    goal_title: goals[1].title,
    kind: "file",
    storage_path: "sources/plan.png",
    original_filename: "training-plan.png",
    content_type: "image/png",
    size: 98221,
    url: "",
    is_deleted: false,
    created_at: iso(-3),
  },
];

const auditEntries = [
  { id: "aud_1", type: "confirm:create_goal", summary: "Created goal “Ship the MVP to 10 paying users”", created_at: iso(-30) },
  { id: "aud_2", type: "confirm:add_plan_item", summary: "Added 4 daily tasks to the MVP plan", created_at: iso(-8) },
  { id: "aud_3", type: "reject:drop_goal", summary: "Declined to drop “Run a half marathon under 2 hours”", created_at: iso(-2) },
];

const memories = [
  {
    id: "mem_1",
    kind: "photo",
    caption: "Whiteboard from the pricing session",
    goal_id: GOAL_MVP,
    goal_title: goals[0].title,
    source_id: "src_photo",
    external_url: null,
    instagram_shortcode: null,
    width: 1200,
    height: 900,
    mime_type: "image/png",
    size_bytes: 98221,
    created_at: iso(-5),
  },
  {
    id: "mem_2",
    kind: "instagram",
    caption: "That race-day reel — the finish-line feeling I'm chasing",
    goal_id: GOAL_RUN,
    goal_title: goals[1].title,
    source_id: null,
    external_url: "https://www.instagram.com/p/example/",
    instagram_shortcode: "example",
    width: null,
    height: null,
    mime_type: null,
    size_bytes: null,
    created_at: iso(-9),
  },
];

const timetable = [
  {
    id: "tt_1",
    user_id: "user_playground",
    block_date: dateOnly(0),
    start_time: "07:00",
    end_time: "07:45",
    label: "Easy 5k",
    kind: "plan_item",
    source: "solver",
    source_id: "pi_6",
    goal_id: GOAL_RUN,
  },
  {
    id: "tt_2",
    user_id: "user_playground",
    block_date: dateOnly(0),
    start_time: "10:00",
    end_time: "12:00",
    label: "Sketch the paywall screen",
    kind: "plan_item",
    source: "solver",
    source_id: "pi_2",
    goal_id: GOAL_MVP,
  },
  {
    id: "tt_3",
    user_id: "user_playground",
    block_date: dateOnly(0),
    start_time: "20:00",
    end_time: "20:30",
    label: "Read 20 pages",
    kind: "anchor",
    source: "user",
    source_id: null,
    goal_id: null,
  },
];

const models = [
  { value: "gemini", label: "Gemini", hint: "3 Flash — fastest" },
  { value: "claude", label: "Claude", hint: "Sonnet 4.5 — best reasoning" },
  { value: "openai", label: "OpenAI", hint: "GPT-5" },
];

/* ------------------------------------------------- chat history + proposals */

const PROPOSAL = {
  id: "prop_1",
  action: "create_goal",
  status: "pending",
  title: "Learn to cook 5 weeknight meals",
  horizon: "monthly",
  why: "You keep ordering in on the days you train.",
  first_action: "Pick the five meals and write the shopping list",
  target_date: dateOnly(45),
};

const history = {
  general: [
    {
      id: "msg_1",
      user_id: "user_playground",
      role: "user",
      content: "I keep missing my running sessions on weeks I travel. Can we plan around that?",
      provider: null,
      proposals: [],
      created_at: iso(-2),
    },
    {
      id: "msg_2",
      user_id: "user_playground",
      role: "assistant",
      content:
        "You've got a travel week coming up (5–12). I'd move the interval work to before you leave and keep only two easy runs while you're away — that protects the streak without pretending you'll train on holiday.",
      provider: "gemini",
      proposals: [],
      created_at: iso(-2),
    },
    // A pending proposal in the general bucket on purpose: it makes the
    // confirm / reject / refine card reachable from the chat FAB, which is the
    // first thing anyone clicks.
    {
      id: "msg_prop",
      user_id: "user_playground",
      role: "assistant",
      content: "Here's what I'd add next. Confirm and I'll put it on the plan.",
      provider: "gemini",
      proposals: [PROPOSAL],
      created_at: iso(-2),
    },
  ],
  // The scoped buckets the app mints per-goal / per-action. Kept separate so
  // opening a goal-scoped chat doesn't show the general conversation.
  "add_goal_goal_mvp": [
    {
      id: "msg_3",
      user_id: "user_playground",
      role: "assistant",
      content: "Here's what I'd add next. Confirm and I'll put it on the plan.",
      provider: "gemini",
      proposals: [PROPOSAL],
      created_at: iso(-1),
    },
  ],
};

/* --------------------------------------------------------------------- store */

export const store = {
  user: {
    user_id: "user_playground",
    id: "user_playground",
    email: "demo@example.com",
    name: "Devanshu",
    image: null,
    picture: null,
    model_provider: "gemini",
    is_guest: false,
    persona_key: null,
  },
  models,

  state: {
    goals,
    milestones,
    blockers,
    plan_items: planItems,
    sources,
    over_commitment: {
      level: "low",
      message: "2 active goals.",
      conflicting: [],
      active_goals: 2,
      open_commitments: planItems.filter((p) => p.status === "open").length,
    },
    audit_summary: { recent: auditEntries.slice(0, 10) },
    // Left empty on purpose: ReplanSuggestions is fed its own shape and a
    // wrong guess here would render a broken card rather than nothing.
    // Set `replan_suggestions` from a mutation (or by hand) to exercise it.
    replan_suggestions: [],
    replan_engine: "review_progress",
    available_weekly_hours: 12,
    generated_at: now(),
  },

  history,
  audit: auditEntries,
  memories,
  timetable,

  motivation: {
    bucket: "stuck",
    items: [
      {
        id: "mot_1",
        kind: "book",
        title: "The War of Art",
        url: "https://example.com/war-of-art",
        author: "Steven Pressfield",
        duration: "2h 40m",
        frame: "For the week you keep reopening the spec instead of writing it.",
      },
      {
        id: "mot_2",
        kind: "video",
        title: "How to run your first half marathon",
        url: "https://example.com/half-marathon",
        author: "Nick Symmonds",
        duration: "12 min",
        frame: "Your 10k milestone is 11 days out — this is the next step after it.",
      },
      {
        id: "mot_3",
        kind: "podcast",
        title: "Pricing for the first ten customers",
        url: "https://example.com/pricing-podcast",
        author: "Lenny's Podcast",
        duration: "48 min",
        frame: "Pairs with the paywall screen you're sketching today.",
      },
    ],
    generated_at: now(),
    cache: "hit",
  },

  /* ----------------------------------------------------------- mutations */

  confirmProposal({ message_id, proposal_id }) {
    for (const bucket of Object.values(history)) {
      const msg = bucket.find((m) => m.id === message_id);
      if (!msg) continue;
      msg.proposals = (msg.proposals || []).map((p) =>
        p.id === proposal_id ? { ...p, status: "confirmed" } : p,
      );
    }
    const proposal = PROPOSAL.id === proposal_id ? PROPOSAL : null;
    if (proposal) {
      goals.push({
        id: id("goal"),
        title: proposal.title,
        horizon: proposal.horizon || "monthly",
        status: "active",
        why: proposal.why || "",
        next_action: proposal.first_action || "",
        target_date: proposal.target_date || dateOnly(45),
        start_date: dateOnly(0),
        drift_status: null,
        weekly_hours: null,
        phase_objectives: {},
        life_area: null,
        sources: [],
      });
      this.state.over_commitment = {
        ...this.state.over_commitment,
        level: "medium",
        message: `${goals.filter((g) => g.status === "active").length} active goals — consider dropping one.`,
        active_goals: goals.filter((g) => g.status === "active").length,
      };
    }
    this.state.generated_at = now();
    // `result` is rendered directly as a chat line, so it must be a string —
    // an object here throws "Objects are not valid as a React child".
    return {
      ok: true,
      result: proposal
        ? `Added the goal “${proposal.title}” to your plan.`
        : "Applied the change.",
      state: this.state,
    };
  },

  rejectProposal({ message_id, proposal_id }) {
    for (const bucket of Object.values(history)) {
      const msg = bucket.find((m) => m.id === message_id);
      if (!msg) continue;
      msg.proposals = (msg.proposals || []).map((p) =>
        p.id === proposal_id ? { ...p, status: "rejected" } : p,
      );
    }
    return { ok: true, result: "Rejected — nothing was changed.", state: this.state };
  },

  refineProposal({ message_id, proposal_id }) {
    const refined = { ...PROPOSAL, id: proposal_id, status: "pending", why: `${PROPOSAL.why} (refined)` };
    for (const bucket of Object.values(history)) {
      const msg = bucket.find((m) => m.id === message_id);
      if (!msg) continue;
      msg.proposals = (msg.proposals || []).map((p) => (p.id === proposal_id ? refined : p));
    }
    return { proposal: refined };
  },

  addBlocker(body) {
    const row = {
      id: id("blk"),
      user_id: this.user.user_id,
      title: body?.title || "New blocker",
      start_date: body?.start_date || dateOnly(0),
      end_date: body?.end_date || dateOnly(1),
      note: body?.note || "",
      created_at: now(),
    };
    blockers.push(row);
    this.state.generated_at = now();
    return row;
  },
  updateBlocker(blockerId, body) {
    const row = blockers.find((b) => b.id === blockerId);
    if (row) Object.assign(row, body || {});
    return row || { detail: "not found" };
  },
  deleteBlocker(blockerId) {
    const i = blockers.findIndex((b) => b.id === blockerId);
    if (i >= 0) blockers.splice(i, 1);
    this.state.generated_at = now();
    return { ok: true };
  },

  addBlock(body) {
    const row = {
      id: id("tt"),
      user_id: this.user.user_id,
      block_date: body?.block_date || dateOnly(0),
      start_time: body?.start_time || "09:00",
      end_time: body?.end_time || "10:00",
      label: body?.label || "New block",
      kind: body?.kind || "anchor",
      source: "user",
      source_id: null,
      goal_id: body?.goal_id || null,
    };
    timetable.push(row);
    return row;
  },
  updateBlock(blockId, body) {
    const row = timetable.find((t) => t.id === blockId);
    if (row) Object.assign(row, body || {});
    return row || { detail: "not found" };
  },
  deleteBlock(blockId) {
    const i = timetable.findIndex((t) => t.id === blockId);
    if (i >= 0) timetable.splice(i, 1);
    return { ok: true };
  },

  addPlanItem(body) {
    const item = {
      id: id("pi"),
      goal_id: body?.goal_id || null,
      horizon: "daily",
      phase: null,
      title: body?.title || "New task",
      note: body?.note || "",
      start_date: body?.due_date || dateOnly(0),
      end_date: body?.due_date || dateOnly(0),
      due_date: body?.due_date || dateOnly(0),
      weekly_hours: null,
      status: "open",
    };
    planItems.push(item);
    this.state.generated_at = now();
    return { plan_item: item };
  },
  updatePlanItem(itemId, patch) {
    const item = planItems.find((p) => p.id === itemId);
    if (item) Object.assign(item, patch || {});
    this.state.generated_at = now();
    return item || { detail: "not found" };
  },

  addLink(body) {
    const row = {
      id: id("src"),
      user_id: this.user.user_id,
      goal_id: body?.goal_id || null,
      goal_title: goals.find((g) => g.id === body?.goal_id)?.title || null,
      kind: "link",
      storage_path: null,
      original_filename: null,
      content_type: null,
      size: null,
      url: body?.url || "",
      is_deleted: false,
      created_at: now(),
    };
    sources.unshift(row);
    this.state.generated_at = now();
    return row;
  },
  previewLink({ url }) {
    return {
      ok: true,
      url,
      host: (() => {
        try {
          return new URL(url).host;
        } catch {
          return "";
        }
      })(),
      title: "Positioning teardown for early-stage SaaS",
      snippet:
        "A worked example of pricing a product with ten customers, including the three questions that decided the number.",
      error: null,
    };
  },
  extractLink({ url }) {
    return {
      ok: true,
      url,
      final_url: url,
      extract: {
        summary:
          "Walks through pricing a small SaaS from first principles, using one company's real numbers.",
        key_points: [
          "Price on value delivered, not hours spent building.",
          "Ten customers is enough signal to set a starting price.",
          "Raise the price before adding features.",
        ],
        extractable_items: [
          "Interview 5 users about willingness to pay",
          "Write the pricing page copy",
          "Set a starting price and revisit in 30 days",
        ],
        suggested_questions: [
          "How should I sequence pricing work against shipping the MVP?",
          "What would make me raise the price too early?",
        ],
      },
      error: null,
    };
  },
  updateSource(sourceId, body) {
    const row = sources.find((s) => s.id === sourceId);
    if (row) Object.assign(row, body || {});
    return row || { detail: "not found" };
  },
  deleteSource(sourceId) {
    const i = sources.findIndex((s) => s.id === sourceId);
    if (i >= 0) sources.splice(i, 1);
    this.state.generated_at = now();
    return { ok: true };
  },

  addMemory(body) {
    const row = {
      id: id("mem"),
      kind: body?.kind === "instagram" ? "instagram" : "photo",
      caption: body?.caption || "",
      goal_id: body?.goal_id || null,
      goal_title: goals.find((g) => g.id === body?.goal_id)?.title || null,
      source_id: body?.source_id || null,
      external_url: body?.external_url || null,
      instagram_shortcode: null,
      width: null,
      height: null,
      mime_type: null,
      size_bytes: null,
      created_at: now(),
    };
    memories.unshift(row);
    return { ok: true, memory: { id: row.id, kind: row.kind } };
  },
  deleteMemory(memoryId) {
    const i = memories.findIndex((m) => m.id === memoryId);
    if (i >= 0) memories.splice(i, 1);
    return { ok: true };
  },

  /**
   * `/chat/plan` → `status: "disabled"`.
   *
   * That is a real server response (the planner feature flag is off) and it
   * makes the client fall back to the SSE `/chat/stream` path — which is the
   * one worth exercising here, since it drives the live typing bubble.
   */
  planResponse() {
    return { status: "disabled" };
  },

  /** Append a turn so a reloaded chat keeps what you typed. */
  recordTurn(bucket, userText, assistantText) {
    const list = history[bucket] || (history[bucket] = []);
    list.push({
      id: id("msg"),
      user_id: this.user.user_id,
      role: "user",
      content: userText,
      provider: null,
      proposals: [],
      created_at: now(),
    });
    list.push({
      id: id("msg"),
      user_id: this.user.user_id,
      role: "assistant",
      content: assistantText,
      provider: "gemini",
      proposals: [],
      created_at: now(),
    });
  },
};
