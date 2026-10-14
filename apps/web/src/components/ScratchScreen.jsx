import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import Scratch from "./Scratch";

/**
 * ScratchScreen — the Scratch page as a Coach panel, wired to `/api/scratch`.
 *
 * The server files each entry in the background, so the screen polls while
 * anything is still being read. Rows are mapped from the API's shape
 * (`waiting` / `handled`) to what `Scratch` draws, and nothing here decides what
 * an entry means: that is the agent's job.
 */

const HOST_HEIGHT = "h-[calc(100vh-13rem)]";
/** How often to re-read while an entry is still pending or processing. */
const POLL_MS = 2000;
const IN_FLIGHT = ["pending", "processing"];

const STATE_LABEL = { pending: "reading…", processing: "reading…" };
const KIND_BODY = { image: "Photo", audio: "Voice note", file: "File" };

const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

const toWaiting = (e) => ({
  id: e.id,
  time: hhmm(e.created_at),
  body: e.body || KIND_BODY[e.kind] || "Entry",
  state: e.status === "pending" ? "processing" : e.status,
  stateLabel: STATE_LABEL[e.status] || (e.status === "needs_input" ? e.question : e.error),
  options: [],
});

const toHandled = (e) => ({
  id: e.id,
  time: hhmm(e.handled_at || e.created_at),
  origin: e.body ? `“${e.body}”` : KIND_BODY[e.kind] || "Entry",
  kind: (e.result?.bucket || "filed").replace(/\+/g, " + "),
  lines: e.result?.lines || [],
  proposal: Boolean(e.result?.proposed),
});

export default function ScratchScreen() {
  const [data, setData] = useState({ waiting: [], handled: [] });

  const load = useCallback(async () => {
    try {
      setData(await api.scratch());
    } catch {
      // A failed refresh keeps what is on screen; the next poll tries again.
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const inFlight = data.waiting.some((e) => IN_FLIGHT.includes(e.status));
  useEffect(() => {
    if (!inFlight) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [inFlight, load]);

  // The composer must not clear until this resolves, so errors propagate to it.
  const capture = async (body) => {
    if (body.kind === "audio" && !body.body) {
      toast.message("Couldn't hear anything. Try again.");
      return;
    }
    await api.createScratch(body);
    await load();
  };

  const upload = (kind) => async (file) => {
    try {
      const source = await api.uploadSource(file, "", { temporary: true });
      await capture({ kind, source_id: source.id });
    } catch (e) {
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't add that. Try again.");
    }
  };

  // The answer goes into a chat scoped to this entry: the agent either asks its
  // next question (shown on the row) or settles what the note means and files it.
  const answer = async (id, reply) => {
    try {
      await api.chatScratch(id, reply);
    } catch (e) {
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't send that. Try again.");
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

  return (
    <Scratch
      className={HOST_HEIGHT}
      inbox={data.waiting.map(toWaiting)}
      handled={data.handled.map(toHandled)}
      onCapture={capture}
      onPhoto={upload("image")}
      onAttach={upload("file")}
      onAnswer={answer}
      onRetry={async (id) => {
        await api.retryScratch(id);
        await load();
      }}
      onUndo={undo}
      onAccept={() => toast.message("Reviewing proposals isn't wired up yet.")}
    />
  );
}
