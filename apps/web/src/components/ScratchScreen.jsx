import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import Scratch from "./Scratch";
import { takePrefetchedScratch } from "../lib/prefetch";

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

  useEffect(() => {
    load();
  }, [load]);

  // Notes left pending by an earlier visit are filed now.
  useEffect(() => {
    data.waiting
      .filter((e) => e.status === "pending" && !filing.current.has(e.id) && Date.now() - new Date(e.created_at).getTime() > ORPHAN_AFTER_MS)
      .forEach((e) => file(e.id));
  }, [data.waiting, file]);

  const inFlight = data.waiting.some((e) => IN_FLIGHT.includes(e.status));
  useEffect(() => {
    if (!inFlight) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [inFlight, load]);

  // Write the entry, show it at once as "reading…", then file it in the background of the screen.
  const write = async (body) => {
    const tempId = `${OPTIMISTIC_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setOptimistic((o) => [{ id: tempId, kind: body.kind, body: body.body || "", status: "pending", created_at: new Date().toISOString() }, ...o]);
    try {
      const row = await api.createScratch(body);
      setData((d) => ({ ...d, waiting: [row, ...d.waiting.filter((e) => e.id !== row.id)] }));
      file(row.id);
      return row;
    } finally {
      setOptimistic((o) => o.filter((e) => e.id !== tempId));
    }
  };

  // A note with attachments: the text rides on the first one, the rest are filed as their own entries.
  const send = async ({ text, attachments }) => {
    try {
      if (attachments.length === 0) {
        await write({ kind: "text", body: text });
        return;
      }
      for (const [i, a] of attachments.entries()) {
        await write({ kind: a.kind === "image" ? "image" : "file", source_id: a.id, body: i === 0 ? text : "" });
      }
    } catch (e) {
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't save that. Try again.");
      throw e;
    }
  };

  const upload = async (file, onProgress) => api.uploadSource(file, "", { temporary: true, onProgress });
  const addLink = async (url, excerpt) => api.addLink({ url, temporary: true, ...(excerpt ? { text: excerpt } : {}) });

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

  const toWaiting = (e) => {
    const working = IN_FLIGHT.includes(e.status);
    return {
      id: e.id,
      answering: Boolean(answering[e.id]),
      time: stamp(e.created_at),
      body: e.body || KIND_BODY[e.kind] || "Entry",
      state: e.status === "pending" ? "processing" : e.status,
      stateLabel: working ? live[e.id] || READING : e.status === "needs_input" ? e.question : e.error,
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
  });

  return (
    <Scratch
      className={HOST_HEIGHT}
      inbox={[...optimistic, ...data.waiting].map(toWaiting)}
      handled={data.handled.map(toHandled)}
      onSend={send}
      onUpload={upload}
      onAddLink={addLink}
      onAnswer={answer}
      onRetry={async (id) => {
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
