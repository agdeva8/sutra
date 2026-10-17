import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import Scratch from "./Scratch";
import { takePrefetchedScratch } from "../lib/prefetch";
import { scratchUploads, UPLOAD_STATE } from "../lib/scratchUploads";

/**
 * ScratchScreen — the Scratch page as a Coach panel, wired to `/api/scratch`.
 *
 * A note is written first (the row exists at once, so nothing is lost) and then filed by a second,
 * streamed request that reports what the agent is doing; that line is shown on the waiting row. If the
 * user leaves before filing finishes, the next visit files whatever is still pending. Rows are mapped
 * from the API's shape (`waiting` / `handled`) to what `Scratch` draws; nothing here decides what an
 * entry means: that is the agent's job.
 */

const HOST_HEIGHT = "h-full";
/** How often to re-read while an entry is still pending or processing. */
const POLL_MS = 2000;
const IN_FLIGHT = ["pending", "processing"];
/** A pending entry this old with nobody filing it was left behind (the user closed the page): pick it up. */
const ORPHAN_AFTER_MS = 4000;

const READING = "Reading…";
const KIND_BODY = { image: "Photo", audio: "Voice note", file: "File" };

/** The row's line while an attachment is still on its way to the server. */
const UPLOAD_LINE = {
  uploading: "Uploading photo…",
  retrying: "Retrying…",
  failed: "Upload failed",
};
const UPLOAD_LINE_FILE = { ...UPLOAD_LINE, uploading: "Uploading file…" };

/**
 * The kind an entry carries when the note has attachments: the first one that isn't a link decides.
 * A note holding only links is a `file` entry with no source yet — `text` requires a body, and a link
 * on its own is a perfectly good note.
 */
const entryKind = (attachments) => {
  // A note holding only links is a `file` entry with no source yet: `text` requires a body, and a link
  // on its own is a perfectly good note.
  if (attachments.length === 0) return "text";
  if (attachments.some((a) => a.kind === "file")) return "file";
  if (attachments.some((a) => a.kind === "image")) return "image";
  return "file";
};

const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const sameDay = (a, b) => a.toDateString() === b.toDateString();
/** "14:05" for today, "12 Oct 14:05" otherwise, so a list spanning days stays readable. */
const stamp = (iso) => {
  const d = new Date(iso);
  return sameDay(d, new Date())
    ? hhmm(iso)
    : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hhmm(iso)}`;
};
const OPTIMISTIC_PREFIX = "pending_";

export default function ScratchScreen() {
  const [data, setData] = useState({ waiting: [], handled: [] });
  // What the agent is saying about each entry being filed right now, by entry id.
  const [live, setLive] = useState({});
  const filing = useRef(new Set());
  // Notes shown the instant Send is pressed, before the server has answered; replaced by the real row.
  const [optimistic, setOptimistic] = useState([]);
  // Entries whose answer is on its way to the agent (blocks a second send, shows a status line).
  const [answering, setAnswering] = useState({});
  // Bumped by the upload queue so a change in an upload redraws its row. The queue itself is the source
  // of truth (`scratchUploads.stateFor`); this is only the subscription's repaint signal.
  const [, setUploadTick] = useState(0);
  // Whether the stored queue has been read this visit. Until it has, an old `pending` row must not be
  // filed: its photo may still be in IndexedDB waiting to resume.
  const [resumed, setResumed] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await (takePrefetchedScratch() || api.scratch()));
    } catch {
      // A failed refresh keeps what is on screen; the next poll tries again.
    }
  }, []);

  // File one entry, streaming what the agent is doing onto its row.
  const file = useCallback(
    async (id) => {
      if (filing.current.has(id)) return;
      filing.current.add(id);
      setLive((l) => ({ ...l, [id]: READING }));
      try {
        await api.processScratch(id, (line) => setLive((l) => ({ ...l, [id]: line })));
      } catch (e) {
        toast.error(typeof e?.message === "string" ? e.message : "Couldn't file that. Try again from Waiting.");
      } finally {
        filing.current.delete(id);
        setLive((l) => {
          const { [id]: _done, ...rest } = l;
          return rest;
        });
        await load();
      }
    },
    [load],
  );
  // The queue's settled handler is installed once and must reach the current `file`, not the first render's.
  const fileRef = useRef(file);
  fileRef.current = file;

  useEffect(() => {
    load();
  }, [load]);

  // The queue outlives this screen, so a new visit attaches to work already in flight rather than
  // starting it again, and picks up anything a closed tab left in IndexedDB.
  useEffect(() => {
    const unsubscribe = scratchUploads.subscribe(() => setUploadTick((n) => n + 1));
    const settle = (id) => fileRef.current?.(id);
    scratchUploads.setSettledHandler(settle);
    scratchUploads.resume().finally(() => setResumed(true));
    return () => {
      unsubscribe();
      scratchUploads.setSettledHandler(null);
    };
  }, []);

  // A note is filed here only when nothing of it is still on the phone. A row left `pending` by an
  // earlier visit, or `processing` past its lease (`e.stale`), is picked up now. `filing` stops a second
  // file while one is in flight; a failure clears it, so the next poll tries again.
  useEffect(() => {
    if (!resumed) return;
    data.waiting
      .filter((e) => !String(e.id).startsWith(OPTIMISTIC_PREFIX))
      .filter((e) => e.status === "pending" || e.stale)
      .filter((e) => Date.now() - new Date(e.created_at).getTime() > ORPHAN_AFTER_MS)
      .filter((e) => !filing.current.has(e.id) && !scratchUploads.hasJobs(e.id))
      .forEach((e) => file(e.id));
  }, [data.waiting, file, resumed]);

  const inFlight = data.waiting.some((e) => IN_FLIGHT.includes(e.status));
  useEffect(() => {
    if (!inFlight) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [inFlight, load]);

  // Write the entry and show it at once. Filing is deliberately not started here: the caller files it
  // now (text only) or after its attachments have all been confirmed (the queue's settled handler).
  const write = async (body) => {
    const tempId = `${OPTIMISTIC_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setOptimistic((o) => [{ id: tempId, kind: body.kind, body: body.body || "", status: "pending", created_at: new Date().toISOString() }, ...o]);
    try {
      const row = await api.createScratch(body);
      setData((d) => ({ ...d, waiting: [row, ...d.waiting.filter((e) => e.id !== row.id)] }));
      return row;
    } finally {
      setOptimistic((o) => o.filter((e) => e.id !== tempId));
    }
  };

  /**
   * Send: one entry, written before anything moves, then each attachment queued behind it. The composer
   * is free the moment the row exists; photos shrink and upload while the person keeps writing.
   */
  const send = async ({ text, attachments }) => {
    try {
      const row = await write({ kind: entryKind(attachments), body: text });
      if (attachments.length === 0) {
        file(row.id);
        return;
      }
      for (const a of attachments) {
        scratchUploads.enqueue(row.id, a);
      }
      // If every attachment somehow finished before the loop returned, the settled handler files it.
    } catch (e) {
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't save that. Try again.");
      throw e;
    }
  };

  // The answer goes into a chat scoped to this entry: the agent either asks its next question (shown on
  // the row) or settles what the note means and files it.
  const answer = async (id, reply) => {
    const text = (reply || "").trim();
    if (!text || answering[id]) return; // empty or whitespace is never sent, and neither is a second send
    setAnswering((a) => ({ ...a, [id]: true }));
    try {
      const res = await api.chatScratch(id, text);
      await load();
      // The agent settled what the note means: file it now, streaming progress onto the row.
      if (res?.resolved) file(id);
    } catch (e) {
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't send that. Try again.");
      await load();
    } finally {
      setAnswering(({ [id]: _done, ...rest }) => rest);
    }
  };

  // Re-point everything this entry filed at a goal (or at none), then redraw the card from the server.
  const linkGoal = async (id, goalId) => {
    try {
      await api.linkGoalScratch(id, goalId);
    } catch (e) {
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't change that goal link.");
    }
    await load();
  };

  const undo = async (id) => {
    try {
      await api.undoScratch(id);
      toast.success("Undone");
    } catch (e) {
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't undo that.");
    }
    await load();
  };

  // "Dismiss" on a proposal: nothing was changed, so there is nothing to undo; the entry just goes away.
  const dismiss = async (id) => {
    try {
      await api.dismissScratch(id);
    } catch (e) {
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't dismiss that.");
    }
    await load();
  };

  /**
   * One waiting entry as the row draws it. A note whose attachment is still on the phone says so instead
   * of "Reading…", and a failed upload turns the row into a failure with a reason and a Retry.
   */
  const toWaiting = (e) => {
    const working = IN_FLIGHT.includes(e.status);
    const upload = scratchUploads.stateFor(e.id);
    let state = e.status === "pending" ? "processing" : e.status;
    let stateLabel = working ? live[e.id] || READING : e.status === "needs_input" ? e.question : e.error;
    if (upload) {
      const lines = upload.kind === "image" ? UPLOAD_LINE : UPLOAD_LINE_FILE;
      if (upload.status === UPLOAD_STATE.failed) {
        state = "failed";
        stateLabel = `${lines.failed}: ${upload.error || "the upload didn't finish"}`;
      } else if (upload.status === UPLOAD_STATE.retrying) {
        state = "processing";
        stateLabel = `${lines.retrying} (${upload.attempt} of ${upload.maxAttempts})`;
      } else {
        state = "processing";
        stateLabel = lines.uploading;
      }
    }
    return {
      id: e.id,
      answering: Boolean(answering[e.id]),
      time: stamp(e.created_at),
      body: e.body || KIND_BODY[e.kind] || "Entry",
      state,
      stateLabel,
      options: [],
    };
  };

  const toHandled = (e) => ({
    id: e.id,
    time: stamp(e.handled_at || e.created_at),
    undoable: e.undoable !== false,
    origin: e.body ? `“${e.body}”` : KIND_BODY[e.kind] || "Entry",
    kind: (e.result?.bucket || "filed").replace(/\+/g, " + "),
    lines: e.result?.lines || [],
    proposal: Boolean(e.result?.proposed),
    // What the entry filed that a goal can be attached to, and the single goal they share now.
    linkable: e.linkable || 0,
    goal: e.goal || null,
  });

  return (
    <Scratch
      className={HOST_HEIGHT}
      inbox={[...optimistic, ...data.waiting].map(toWaiting)}
      handled={data.handled.map(toHandled)}
      goals={data.goals || []}
      onLinkGoal={linkGoal}
      onSend={send}
      onAnswer={answer}
      onRetry={async (id) => {
        // A failed attachment is retried on the phone, not by asking the server again.
        if (scratchUploads.retryEntry(id)) return;
        try {
          await api.retryScratch(id);
          await load();
          file(id);
        } catch (e) {
          toast.error(typeof e?.message === "string" ? e.message : "Couldn't retry that.");
        }
      }}
      onUndo={undo}
      onDismiss={dismiss}
      onAccept={() => toast.message("Reviewing proposals isn't wired up yet.")}
    />
  );
}
