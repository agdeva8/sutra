import { withTimeout, TimeoutError } from "./fetch-with-timeout";

export { TimeoutError };

// `frontend/.env` is gitignored, so a Vercel git build has this unset. It must
// fall back to "" (relative `/api` on this origin), otherwise the template
// produces the literal URL "undefined/api" and every request 404s. Only set a
// full URL when the API genuinely lives on another origin (local dev).
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
export const API = `${BACKEND_URL}/api`;

const DEFAULT_TIMEOUT_MS = 30000;

async function req(path, opts = {}) {
  const { quiet, timeout = DEFAULT_TIMEOUT_MS, ...fetchOpts } = opts;
  const controller = new AbortController();
  const signal = fetchOpts.signal || controller.signal;

  const res = await withTimeout(
    fetch(`${API}${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(fetchOpts.headers || {}) },
      ...fetchOpts,
      signal,
    }),
    timeout,
    `API ${path}`,
    { controller, signal },
  );

  // `quiet: true` swallows the error so callers can branch on a
  // null/defined return instead of catching. Used by the auth probe
  // so cold-start 401s don't show up as console noise on every page
  // load when the user isn't signed in.
  if (!res.ok) {
    if (quiet && res.status >= 400 && res.status < 500) {
      return null;
    }
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}

export const api = {
  me: () => req("/auth/me", { quiet: true }),
  guest: () => req("/auth/guest", { method: "POST" }),
  session: (session_id) => req("/auth/session", { method: "POST", body: JSON.stringify({ session_id }) }),
  logout: () => req("/auth/logout", { method: "POST" }),
  setProvider: (model_provider) => req("/preferences", { method: "PUT", body: JSON.stringify({ model_provider }) }),
  models: () => req("/preferences/models"),
  state: () => req("/state"),
  // Conversation-scoped history. Pass { refId, kind } (or { scope }) to
  // fetch a specific chat bucket; omit for the general bucket. Without
  // this every chat surface showed the user's entire message history.
  history: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.refId) qs.set("refId", params.refId);
    if (params.kind) qs.set("kind", params.kind);
    if (params.scope) qs.set("scope", params.scope);
    const q = qs.toString();
    return req(`/chat/history${q ? `?${q}` : ""}`);
  },
  clearHistory: () => req("/chat/history", { method: "DELETE" }),
  audit: () => req("/audit"),
  confirm: (message_id, proposal_id) =>
    req("/tools/confirm", { method: "POST", body: JSON.stringify({ message_id, proposal_id }) }),
  reject: (message_id, proposal_id, reason) =>
    req("/tools/reject", {
      method: "POST",
      body: JSON.stringify({ message_id, proposal_id, reason: reason || undefined }),
    }),
  // Iteration 9 — refine a proposal in place. The server LLM is called
  // once with the user's thought; the response is the SAME proposal
  // shape (id, action, args, status:'pending') that REPLACES the old
  // one in the parent message. No streaming — the modal shows a
  // loading spinner, then swaps the proposal card.
  refine: (message_id, proposal_id, thought) =>
    req("/chat/refine", {
      method: "POST",
      body: JSON.stringify({ message_id, proposal_id, thought }),
    }),
  // Blockers (direct edit)
  blockers: () => req("/blockers"),  createBlocker: (b) => req("/blockers", { method: "POST", body: JSON.stringify(b) }),
  updateBlocker: (id, b) => req(`/blockers/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  deleteBlocker: (id) => req(`/blockers/${id}`, { method: "DELETE" }),
  // Timetable blocks (direct edit — Hard constraint #2)
  timetable: () => req("/timetable"),
  createBlock: (b) => req("/timetable", { method: "POST", body: JSON.stringify(b) }),
  updateBlock: (id, b) => req(`/timetable/${id}`, { method: "PUT", body: JSON.stringify(b) }),
  deleteBlock: (id) => req(`/timetable/${id}`, { method: "DELETE" }),
  // Plan items (multi-horizon execution lattice) — tick a task done/open, or
  // add a user-owned daily task directly.
  createPlanItem: (p) => req("/plan-items", { method: "POST", body: JSON.stringify(p) }),
  updatePlanItem: (id, patch) => req(`/plan-items/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  // Sources
  sources: () => req("/sources"),
  getSource: (id) => req(`/sources/${id}`),
  updateSource: (id, body) => req(`/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  addLink: (body) => req("/sources/link", { method: "POST", body: JSON.stringify(body) }),
  previewLink: (url) => req("/sources/link/preview", { method: "POST", body: JSON.stringify({ url }) }),
  // Iteration 11 — LLM link exploration. extractLink asks the coach to
  // read the fetched/pasted document and return a structured preview of
  // what it can pull out (summary, key points, extractable items,
  // suggested questions). askLink is the to-and-fro stream helper used by
  // the LinkPreviewDialog's ask panel.
  extractLink: (body) => req("/sources/link/extract", { method: "POST", body: JSON.stringify(body) }),
  deleteSource: (id) => req(`/sources/${id}`, { method: "DELETE" }),
  uploadSource: async (file, goalId = "", { temporary = false } = {}) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("goal_id", goalId);
    if (temporary) fd.append("temporary", "true");
    const controller = new AbortController();
    const res = await withTimeout(
      fetch(`${API}/sources/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
        signal: controller.signal,
      }),
      DEFAULT_TIMEOUT_MS,
      "API /sources/upload",
      { controller },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Upload failed");
    }
    return res.json();
  },
  // Memories
  memories: () => req("/memories"),
  createMemory: (body) => req("/memories", { method: "POST", body: JSON.stringify(body) }),
  deleteMemory: (id) => req(`/memories/${id}`, { method: "DELETE" }),
  // Motivation — read-only feed. No refresh param: the backend
  // refreshes its own cache in the background.
  motivation: () => req("/motivation/recommend"),
  // Iteration 10 — Goal Planner. Non-streaming typed pipeline for the five
  // planned chat kinds. Returns { status, prose, proposals?, headroom?, plan?,
  // questions?, options?, reason? }. status:'disabled' means the server flag is
  // off and the caller should fall back to the SSE /chat/stream path. The
  // server may take up to ~60s on a big plan, so this call opts into the max
  // client timeout rather than the 30s default.
  plan: (body) =>
    req("/chat/plan", { method: "POST", body: JSON.stringify(body), timeout: 60000 }),
};

export function exportUrl() {
  return `${API}/audit/export`;
}

export function sourceDownloadUrl(id) {
  return `${API}/sources/${id}/download`;
}
