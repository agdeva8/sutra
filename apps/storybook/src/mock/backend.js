/**
 * In-page mock backend for the interactive playground.
 *
 * The real frontend talks to `/api/*` through src/lib/api.js. Rather than mock
 * each component's data hook, this patches `window.fetch` once and serves every
 * `/api/*` request from the in-memory store in ./fixtures.js.
 *
 * Two reasons it lives at the fetch layer:
 *   - The copied app code stays byte-identical to the main worktree, so a bug
 *     found here maps back to a real line there.
 *   - Writes mutate the store, so the app is genuinely interactive: confirming
 *     a proposal adds a goal, ticking a task sticks, and sending a chat turn
 *     appends to the conversation.
 *
 * Response envelopes are copied from the live contract — note they are NOT
 * uniform: `/chat/history`, `/audit`, `/blockers`, `/timetable` and `/sources`
 * are bare arrays, while `/memories` is wrapped in `{ memories }`.
 *
 * Anything unhandled 404s with a visible `detail` and is recorded in
 * `missingRoutes`, which the playground shell surfaces, so a blank screen tells
 * you which endpoint needs a fixture instead of failing silently.
 */
import { store } from "./fixtures";

const originalFetch = window.fetch.bind(window);

/** Endpoint paths this mock was asked for but has no fixture for. */
export const missingRoutes = new Set();

function json(body, status = 200) {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(body, status = 200, contentType = "text/plain") {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

function splitPath(url) {
  const { pathname, searchParams } = new URL(url, window.location.origin);
  const path = pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  return { path, query: searchParams };
}

/* ------------------------------------------------------------------- chat */

const SCOPE_TO_KIND = {
  goal: "add_goal",
  commitment: "plan_day",
  milestone: "plan_day",
  blocker: "plan_day",
  generic: "general",
};

/** Mirror the server's conversation-id derivation so buckets stay separate. */
function bucketKey({ refId, kind, scope }) {
  const scopedKind = kind || (scope ? SCOPE_TO_KIND[scope] || "general" : "general");
  return refId ? `${scopedKind}_${refId}` : "general";
}

function mockReply(message) {
  const m = (message || "").toLowerCase();
  if (m.includes("travel") || m.includes("blocker") || m.includes("busy")) {
    return "You've got a family trip from the 5th to the 12th. I'd front-load the interval work before you leave and keep only two easy runs while you're away — that protects the streak without pretending you'll train on holiday.";
  }
  if (m.includes("price") || m.includes("pricing")) {
    return "Price against the value, not the hours. Your positioning notes already say the buyer is a solo founder — so anchor on what a saved week is worth to them, put a number on the page, and revisit it after ten customers rather than after ten features.";
  }
  if (m.includes("run") || m.includes("10k")) {
    return "Your 10k milestone is eleven days out. Add one long run this weekend at conversational pace, keep the interval session midweek, and take the day before the attempt completely off.";
  }
  return "Here's how I'd sequence that. First, protect the two commitments already on the plan this week; second, add the smallest next step that moves the quarter goal; third, put a review at the end of the week so we can see whether it held. Want me to draft the steps?";
}

/**
 * POST /chat/stream — SSE, matching the wire format the client parses
 * (`ChatModal.js`): one `delta` per chunk, then a single `done`.
 */
function streamChat(body, messageIdPrefix = "msg") {
  const userText = body?.message || "";
  const reply = mockReply(userText);
  const key = bucketKey(body || {});
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const words = reply.split(" ");
      for (let i = 0; i < words.length; i++) {
        send({ type: "delta", content: (i ? " " : "") + words[i] });
        // Slow enough that the streaming bubble is visibly a stream.
        await new Promise((r) => setTimeout(r, 24));
      }
      const messageId = `${messageIdPrefix}_${Date.now()}`;
      send({
        type: "done",
        message_id: messageId,
        provider: "gemini",
        redirected: false,
        ref_id: body?.refId || "",
      });
      store.recordTurn(key, userText, reply);
      notifyStoreChange();
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/* ------------------------------------------------------------------ routes */

/**
 * Keys are `"<METHOD> <path>"`; a `:name` segment matches one path segment and
 * arrives as `params.name`. Handlers return a plain body (JSON-serialised) or a
 * `Response` (SSE, downloads).
 */
// Scratch mock: an entry lands "pending", then is "handled" a moment later with
// canned lines, so the Scratch screen can be clicked through with no model.
const SCRATCH_MOCK_DELAY_MS = 1800;
const scratchRows = [];
function scratchHandled(row) {
  const lines =
    row.kind === "image"
      ? ["Reminder: Take Tab Azithromycin 500 mg, 1 tablet once daily on 3 day(s) at 09:00", "Kept in Sources: Prescription"]
      : [`New task: ${row.body.slice(0, 40)} (1h)`, "Planned: Thu 15 Oct 09:00-10:00"];
  Object.assign(row, { status: "handled", result: { bucket: row.kind === "image" ? "reminder+source" : "task", lines, proposed: false }, handled_at: new Date().toISOString() });
  notifyStoreChange();
}

// Calendar feed mock: mirrors apps/api/sutra_api/api/calendar.py's envelope.
const CAL_MOCK_TOKEN = "mockFeedToken123";
const calFeed = { enabled: false, prompted: false, last_fetched_at: null };
function calEnvelope() {
  if (!calFeed.enabled) return { ...calFeed };
  const ics = `https://api.sutra.app/api/calendar/ics/${CAL_MOCK_TOKEN}.ics`;
  const webcal = ics.replace("https://", "webcal://");
  return {
    ...calFeed,
    ics_url: ics,
    webcal_url: webcal,
    google_url: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
    outlook_url: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(ics)}&name=Sutra%20plan`,
  };
}
/** Stories call this to start from a known feed state. */
export function setMockCalendarFeed(next) {
  Object.assign(calFeed, { enabled: false, prompted: false, last_fetched_at: null }, next);
}

const ROUTES = {
  "GET calendar/feed": () => calEnvelope(),
  "POST calendar/feed": () => {
    Object.assign(calFeed, { enabled: true, prompted: true });
    return calEnvelope();
  },
  "POST calendar/feed/dismiss": () => {
    calFeed.prompted = true;
    return calEnvelope();
  },
  "DELETE calendar/feed": () => {
    Object.assign(calFeed, { enabled: false, last_fetched_at: null });
    return calEnvelope();
  },
  "GET scratch": () => ({
    waiting: scratchRows.filter((r) => r.status !== "handled").reverse(),
    handled: scratchRows.filter((r) => r.status === "handled").reverse(),
  }),
  "POST scratch": ({ body }) => {
    const row = { id: `scratch_${scratchRows.length + 1}`, kind: body.kind || "text", body: body.body || "", source_id: body.source_id || null, status: "pending", question: null, error: null, result: null, created_at: new Date().toISOString(), handled_at: null };
    scratchRows.push(row);
    setTimeout(() => scratchHandled(row), SCRATCH_MOCK_DELAY_MS);
    return row;
  },
  "POST scratch/:id/retry": ({ params }) => {
    const row = scratchRows.find((r) => r.id === params.id);
    if (row) setTimeout(() => scratchHandled(row), SCRATCH_MOCK_DELAY_MS);
    return row;
  },
  "POST scratch/:id/chat": ({ params, body }) => {
    const row = scratchRows.find((r) => r.id === params.id);
    if (row) setTimeout(() => scratchHandled(row), SCRATCH_MOCK_DELAY_MS);
    if (row) Object.assign(row, { status: "pending", question: null });
    return { reply: `Got it, filing “${(body.message || "").slice(0, 40)}”.`, resolved: true, entry: row };
  },
  "POST scratch/:id/undo": ({ params }) => {
    const i = scratchRows.findIndex((r) => r.id === params.id);
    if (i >= 0) scratchRows.splice(i, 1);
    return { reverted: 1, not_restored: [] };
  },
  "POST goals/intake": ({ body }) =>
    body.state?.turns?.length
      ? { kind: "draft", question: null, options: [], state: body.state, draft: { title: "Learn to drive and get licensed", why: body.message, life_area: "", total_hours: 40, deadline_weeks: 12, milestones: [{ title: "Book driving school", week: 2 }, { title: "Pass the theory test", week: 6 }, { title: "Road test", week: 12 }] } }
      : { kind: "question", question: "Where are you starting from right now?", options: ["No permit yet", "Permit, no car", "Permit and a car"], state: { turns: [{ role: "user", text: body.message }, { role: "assistant", text: "Where are you starting from right now?" }], questions_asked: 1 }, draft: null },
  "POST goals/intake/confirm": () => ({ goal_id: "goal_mock", plan: { status: "applied", applied: 34, proposed: 0, notes: [] } }),
  "DELETE scratch/:id": ({ params }) => {
    const i = scratchRows.findIndex((r) => r.id === params.id);
    if (i >= 0) scratchRows.splice(i, 1);
    return { ok: true };
  },
  "GET auth/me": () => store.user,
  "POST auth/guest": () => ({ user: store.user }),
  "POST auth/session": () => ({ user: store.user }),
  "POST auth/logout": () => ({ ok: true }),
  // 404 mirrors ALLOW_DEV_LOGIN being off, which is how a normal user sees the
  // app. The dev buttons stay hidden rather than leading somewhere mock-only.
  "GET auth/dev-login": () => json({ detail: "Dev login disabled" }, 404),
  "POST auth/dev-login": () => json({ detail: "Dev login disabled" }, 404),
  "GET auth/personas": () => ({ personas: [] }),

  "GET preferences/models": () => ({ models: store.models }),
  "PUT preferences": ({ body }) => {
    if (body?.model_provider) store.user.model_provider = body.model_provider;
    return { model_provider: store.user.model_provider };
  },

  "GET state": () => store.state,
  "GET audit": () => store.audit,
  "GET audit/export": () => text("# Mock audit export\n\nNothing to export in the playground.\n", 200, "text/markdown"),

  "GET chat/history": ({ query }) =>
    store.history[
      bucketKey({
        refId: query.get("refId"),
        kind: query.get("kind"),
        scope: query.get("scope"),
      })
    ] || [],
  "DELETE chat/history": () => {
    for (const k of Object.keys(store.history)) store.history[k] = [];
    return { success: true };
  },
  "POST chat/stream": ({ body }) => streamChat(body),
  // The planner flag is off server-side → the client falls back to SSE.
  "POST chat/plan": () => store.planResponse(),

  "POST tools/confirm": ({ body }) => store.confirmProposal(body || {}),
  "POST tools/reject": ({ body }) => store.rejectProposal(body || {}),
  "POST chat/refine": ({ body }) => store.refineProposal(body || {}),

  "GET blockers": () => store.state.blockers,
  "POST blockers": ({ body }) => store.addBlocker(body),
  "PUT blockers/:id": ({ params, body }) => store.updateBlocker(params.id, body),
  "DELETE blockers/:id": ({ params }) => store.deleteBlocker(params.id),

  "GET timetable": () => store.timetable,
  "POST timetable": ({ body }) => store.addBlock(body),
  "PUT timetable/:id": ({ params, body }) => store.updateBlock(params.id, body),
  "DELETE timetable/:id": ({ params }) => store.deleteBlock(params.id),

  "POST plan-items": ({ body }) => store.addPlanItem(body),
  "PATCH plan-items/:id": ({ params, body }) => store.updatePlanItem(params.id, body),

  "GET sources": () => store.state.sources,
  "POST sources/link": ({ body }) => store.addLink(body),
  "POST sources/link/preview": ({ body }) => store.previewLink(body || {}),
  "POST sources/link/extract": ({ body }) => store.extractLink(body || {}),
  "POST sources/link/ask": ({ body }) => streamChat(body, "linkmsg"),
  "POST sources/upload": ({ body }) => {
    const file = body && typeof body.get === "function" ? body.get("file") : null;
    const row = {
      id: `src_${Date.now()}`,
      user_id: store.user.user_id,
      goal_id: (body && typeof body.get === "function" && body.get("goal_id")) || null,
      goal_title: null,
      kind: "file",
      storage_path: "sources/upload",
      original_filename: (file && file.name) || "upload.bin",
      content_type: (file && file.type) || "application/octet-stream",
      size: (file && file.size) || 0,
      url: "",
      is_deleted: false,
      text_pending: true,
      created_at: new Date().toISOString(),
    };
    store.state.sources.unshift(row);
    store.state.generated_at = new Date().toISOString();
    return row;
  },
  "GET sources/:id": ({ params }) =>
    store.state.sources.find((s) => s.id === params.id) || { detail: "not found" },
  "PATCH sources/:id": ({ params, body }) => store.updateSource(params.id, body),
  "DELETE sources/:id": ({ params }) => store.deleteSource(params.id),
  "GET sources/:id/download": ({ params }) => text(`mock bytes for source ${params.id}`),

  "GET memories": () => ({ memories: store.memories }),
  "POST memories": ({ body }) => store.addMemory(body),
  "DELETE memories/:id": ({ params }) => store.deleteMemory(params.id),

  "GET motivation/recommend": () => store.motivation,
};

function matchRoute(method, path) {
  const direct = ROUTES[`${method} ${path}`];
  if (direct) return { handler: direct, params: {} };

  const want = path.split("/");
  for (const key of Object.keys(ROUTES)) {
    const sp = key.indexOf(" ");
    if (key.slice(0, sp) !== method) continue;
    const have = key.slice(sp + 1).split("/");
    if (have.length !== want.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < have.length; i++) {
      if (have[i].startsWith(":")) params[have[i].slice(1)] = decodeURIComponent(want[i]);
      else if (have[i] !== want[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: ROUTES[key], params };
  }
  return null;
}

async function readBody(init) {
  if (!init || !init.body) return undefined;
  // FormData (uploads) is passed through untouched — the handler reads it.
  if (typeof init.body !== "string") return init.body;
  try {
    return JSON.parse(init.body);
  } catch {
    return undefined;
  }
}

const listeners = new Set();
/** Subscribe to "the store changed" — used by the playground shell. */
export function onStoreChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notifyStoreChange() {
  listeners.forEach((fn) => fn());
}

window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);

  if (!/\/api(\/|$)/.test(url)) return originalFetch(input, init);

  const { path, query } = splitPath(url);
  const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
  const match = matchRoute(method, path);

  if (!match) {
    missingRoutes.add(`${method} /api/${path}`);
    return json({ detail: `no mock route for ${method} /api/${path}` }, 404);
  }

  try {
    const body = await readBody(init);
    const result = match.handler({ params: match.params, body, query, init });
    const payload = result instanceof Response ? result : json(result);
    if (method !== "GET") notifyStoreChange();
    return payload;
  } catch (e) {
    return json({ detail: String((e && e.message) || e) }, 500);
  }
};

export { originalFetch };
