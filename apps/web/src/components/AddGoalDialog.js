import { useCallback, useEffect, useRef, useState } from "react";
import {
  Sparkles,
  ArrowLeft,
  HeartPulse,
  Briefcase,
  BookOpen,
  HeartHandshake,
  TrendingUp,
  Wrench,
  Wand2,
  Check,
  RefreshCw,
  Pencil,
  Loader2,
} from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import ChatConsole from "./ChatConsole";
import RefineModal from "./RefineModal";
import RejectModal from "./RejectModal";
import { CONFIRM_STATUS, CLOSE_AFTER_CONFIRM_MS } from "../constants/progress";
import SourcesAskCard from "./SourcesAskCard";
import AboutYouCard from "./AboutYouCard";
import RenegotiationDialog from "./RenegotiationDialog";
import { useDialogBack } from "../hooks/useDialogBack";
import { usePlanSend, renegotiationChoiceLabel, clearRenegotiation } from "../hooks/use-plan-send";
import { toast } from "sonner";
import { api, API } from "../lib/api";
import { SOURCE_FILE_ACCEPT, sourceChipLabel } from "../lib/sources";
import { buildSchedule } from "../lib/goalPlanning";
import { readDraftBucket, writeDraftBucket, clearDraftBucket } from "../hooks/useDraftPersistence";

/**
 * CATEGORIES — hero cards for picking a goal area.
 *
 * Every gradient stays inside the warm spectrum (amber / orange / rose /
 * stone / accent) so the surface matches the rest of the app's warm
 * dark / light theme. Differentiation comes from icon + label + a
 * slight gradient-direction shift, not from hue jumps that fight the
 * palette. The "Something else" tile is the only one that uses the
 * canonical --accent so it reads as the meta / catch-all choice.
 */
/**
 * The dialog opens straight into the chat: the user writes the goal in their own words and the
 * coach works out the area. The category tiles are kept below for a future "browse by area" entry.
 */
const INITIAL_STEP = "chat";

/**
 * The newest pending `create_goal` in the conversation, or null.
 *
 * One Add-goal plan makes one goal, but a coach reply can carry two goal cards — a repeated
 * proposal, or a refined copy beside the original. Confirming every pending proposal then creates
 * two goals. This is the client's half of the rule (the coach drops earlier cards at the source,
 * and `/tools/confirm` skips extra ones in a batch): the newest goal is the one to confirm, and
 * older cards are marked superseded instead. Exported so the rule is testable without rendering
 * the dialog.
 */
export function newestPendingCreateGoal(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const proposals = messages[i]?.proposals || [];
    for (let j = proposals.length - 1; j >= 0; j--) {
      const proposal = proposals[j];
      if (proposal.action === "create_goal" && (proposal.status || "pending") === "pending") {
        return proposal;
      }
    }
  }
  return null;
}

const CATEGORIES = [
  {
    id: "health",
    label: "Health",
    Icon: HeartPulse,
    gradient: "from-amber-500/25 via-yellow-500/12 to-amber-500/0",
    ring: "ring-amber-400/40",
    glow: "bg-amber-400/20",
    prompt: "Help me set up a health goal. Ask anything you need, then propose it.",
  },
  {
    id: "career",
    label: "Career",
    Icon: Briefcase,
    gradient: "from-orange-500/30 via-amber-500/12 to-red-500/0",
    ring: "ring-orange-400/40",
    glow: "bg-orange-400/20",
    prompt: "Help me set up a career goal. Ask anything you need, then propose it.",
  },
  {
    id: "learning",
    label: "Learning",
    Icon: BookOpen,
    gradient: "from-yellow-500/22 via-amber-300/10 to-yellow-600/0",
    ring: "ring-yellow-400/40",
    glow: "bg-yellow-400/15",
    prompt: "Help me set up a learning goal. Ask anything you need, then propose it.",
  },
  {
    id: "relationship",
    label: "Relationship",
    Icon: HeartHandshake,
    gradient: "from-rose-500/25 via-pink-400/10 to-rose-600/0",
    ring: "ring-rose-400/40",
    glow: "bg-rose-400/15",
    prompt: "Help me set up a relationship goal. Ask anything you need, then propose it.",
  },
  {
    id: "finance",
    label: "Finance",
    Icon: TrendingUp,
    gradient: "from-amber-600/28 via-orange-500/12 to-amber-700/0",
    ring: "ring-amber-500/40",
    glow: "bg-amber-500/15",
    prompt: "Help me set up a finance goal. Ask anything you need, then propose it.",
  },
  {
    id: "side-project",
    label: "Side project",
    Icon: Wrench,
    gradient: "from-stone-500/25 via-stone-400/10 to-stone-600/0",
    ring: "ring-stone-400/40",
    glow: "bg-stone-400/15",
    prompt: "Help me set up a side-project goal. Ask anything you need, then propose it.",
  },
  {
    id: "custom",
    label: "Something else",
    Icon: Wand2,
    gradient: "from-[color-mix(in_srgb,var(--accent)_25%,transparent)] via-[color-mix(in_srgb,var(--accent)_10%,transparent)] to-transparent",
    ring: "ring-[color-mix(in_srgb,var(--accent)_50%,transparent)]",
    glow: "bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]",
    prompt: "",
  },
];

/**
 * AddGoalDialog — 2-step flow:
 *
 *   Step 1 (tile-only): Big aesthetic category tiles. No chat visible.
 *     User picks one to advance.
 *
 *   Step 2 (chat): Same tiles stay pinned at the top (clickable to
 *     change selection or return to step 1). Below them, an isolated
 *     ChatConsole opens with its OWN state — same component, different
 *     context from the left-hand console.
 *
 * The dialog auto-closes after a successful confirm.
 */
/** "Confirm 9 items", or "Confirm 9 items · 1 removed" once the user has rejected some. */
const confirmLabel = (count, removed) =>
  `Confirm ${count} ${count === 1 ? "item" : "items"}${removed > 0 ? ` · ${removed} removed` : ""}`;

/**
 * One message carries every marked card, and asks for a whole re-plan rather
 * than a patch: a milestone that moves dates everything after it, so the coach
 * has to re-date and re-size the plan as a whole, and may need a milestone that
 * was not in the first draft.
 */
const CHANGE_REQUEST =
  "Re-plan the whole goal around these changes. Re-date and re-size every milestone so it fits, and add or drop milestones if the change needs it. Keep everything we've discussed (answers, attachments, assumptions), and keep the title unless I asked to rename it.";

/** A change set that only removes cards needs no re-plan — just drop them. */
const REMOVE_ONLY_REQUEST = "Remove these and keep the rest of the plan as it is.";

/**
 * The first turn of an edit. The server is told this is an edit (`edit_goal`), so it revises the goal
 * rather than proposing a second one; the message itself asks for the whole open plan again, because a
 * refinement that changes one milestone usually moves the ones after it.
 */
const EDIT_OPEN_MESSAGE =
  "I want to refine this goal. Re-propose the whole plan — the goal and every open milestone — starting from the current plan, and keep the milestones already done fixed.";


/** The one message that asks the coach to take in sources attached after a plan exists. */
const sourceUpdateMessage = (names) => {
  const quoted = names.map((name) => `"${name}"`).join(", ");
  const one = names.length === 1;
  return `I just attached ${one ? quoted : `${names.length} sources: ${quoted}`} — read ${one ? "it" : "them"} and re-propose the plan so the goal, milestones and tasks reflect what ${one ? "it says" : "they say"}.`;
};

export default function AddGoalDialog({
  open,
  onClose,
  // "add" writes a new goal; "edit" revises `goal` in its own conversation (see the open effect).
  mode = "add",
  // The goal being edited, with its milestones (`{id, title, target_date, weekly_hours, milestones}`).
  // Only read in edit mode.
  goal = null,
  onStepBack = null,
  autoAnswer: initialAutoAnswer = true,
  grillMe: initialGrillMe = false,
  onUploadSource,
  onAddLink,
  onDeleteSource,
  onGoalConfirmed,
  registerCloser = null,
}) {
  // Dialog-internal chat state — completely isolated from the parent.
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [busyProposal, setBusyProposal] = useState(null);
  const [pendingClarifications, setPendingClarifications] = useState(null);
  const [renegotiation, setRenegotiation] = useState(null);
  const [busyChoice, setBusyChoice] = useState(null);
  // True from the tap until the confirm's reply lands. `sending` disables the button on the next
  // render only, so a second tap in the same frame would still reach `confirm`; this ref closes that
  // gap and makes the second tap a no-op.
  const confirmingRef = useRef(false);
  const [showDraftPrompt, setShowDraftPrompt] = useState(false);
  const streamIdRef = useRef(0);
  // Operation-scoped context (spec §10) — the current conversation
  // bucket. Minted fresh on every dialog open; swapped only on
  // confirm (server pre-mints the next bucket) or when the server's
  // `done` event reports a defensive redirect off a closed bucket.
  const refIdRef = useRef(`new_goal_${crypto.randomUUID()}`);

  const isEdit = mode === "edit" && !!goal?.id;
  // The edit's opening turn is sent once per dialog open, after its thread has loaded — not on every
  // re-render of the open effect (React StrictMode mounts effects twice).
  const editSentRef = useRef(false);

  // UI state for the 2-step flow.
  const [activeCategory, setActiveCategory] = useState(null);
  // The "about you" step: shown before anything else while the profile has never been asked. A failed
  // fetch leaves it hidden, so a flaky network never blocks adding a goal.
  const [profileNeeded, setProfileNeeded] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    api
      .getProfile()
      .then((data) => {
        if (!cancelled) setProfileNeeded(!data?.profile?.asked);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);
  const saveProfile = async (profile) => {
    await api.putProfile(profile);
    setProfileNeeded(false);
  };
  const [step, setStep] = useState(INITIAL_STEP); // "tiles" | "chat"
  // Iteration 5 (Bug 10) — bump every tiles→chat transition so React
  // remounts <ChatConsole> via `key` and re-fires its focus effect.
  // The old `focusOnMount={step === "chat"}` only flipped once on the
  // first cycle, so the second / third "change category" round
  // landed without focus on the textarea.
  const [focusToken, setFocusToken] = useState(0);
  // Iteration 9 — which proposal (if any) is being refined / rejected.
  // Each modal owns its own input; the dialog owns the lifecycle.
  const [refiningProposal, setRefiningProposal] = useState(null);
  const [rejectingProposal, setRejectingProposal] = useState(null);
  // Step-aware back ref. `useDialogBack` is called before
  // `handleStepBack` is defined, so we hand it a stable wrapper that
  // reads this ref. When the browser/system back button fires, it
  // retreats chat → tiles (category still selected) instead of
  // closing the dialog. Only a back press on the tiles step closes.
  const stepBackRef = useRef(null);
  // Iteration 9+ — back button peels one layer: chat → tiles → close.
  useDialogBack(open, () => stepBackRef.current?.(), "add-goal-dialog");

  // Nested closer registration — the Refine / Reject modals live
  // inside this dialog and own their own input. When the global back
  // button is pressed while one of them is open, it must close THAT
  // modal before it closes the parent AddGoalDialog. Register the
  // closer here so Coach.js's back-stack knows the layer exists.
  useEffect(() => {
    if (!refiningProposal || !registerCloser) return;
    return registerCloser(() => setRefiningProposal(null));
  }, [refiningProposal, registerCloser]);
  useEffect(() => {
    if (!rejectingProposal || !registerCloser) return;
    return registerCloser(() => setRejectingProposal(null));
  }, [rejectingProposal, registerCloser]);
  const enterChat = (next) => {
    setStep(next ?? "chat");
    setFocusToken((t) => t + 1);
  };
  // Mode for the dialog's chat input. Seeded from the parent's mode
  // so the dialog opens on whatever mode the user is in globally.
  // Tracked locally after that — the previous `() => {}` no-op setters
  // made it look like the dropdown reverted after every pick.
  const [autoAnswer, setAutoAnswer] = useState(initialAutoAnswer);
  const [grillMe, setGrillMe] = useState(initialGrillMe);
  // Sources attached within this dialog session (attached to a goal
  // once it's created — shown as chips above the chat textarea).
  const [sources, setSources] = useState([]);
  // The first message is held while the user is asked about sources; null when nothing is held.
  const [heldFirst, setHeldFirst] = useState(null);
  // Once the plan is confirmed the conversation is a record, not a draft: the composer goes away.
  const [planConfirmed, setPlanConfirmed] = useState(false);
  // From the moment Confirm is pressed until the dialog closes, the chat is frozen and says what is happening.
  const [finalStatus, setFinalStatus] = useState("");
  const autoResumePendingRef = useRef(false);
  const reusedDraftRef = useRef(false);
  // Sources attached while a plan is already on screen. They are collected
  // here, not sent on attach: the founder added a link and then could not add
  // a PDF because the first attach had already started a re-plan. One
  // "Update plan with N sources" sends all of them in a single message.
  const [pendingSourceIds, setPendingSourceIds] = useState([]);
  // Set when "Make changes" is sent; once the coach's next proposal lands the
  // marks on the old cards are cleared, so they do not linger as pending edits.
  const clearMarksRef = useRef(false);
  const previousModeRef = useRef({ autoAnswer: initialAutoAnswer, grillMe: initialGrillMe });
  const sendRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    // Reset the OPEN-SCOPED transient state only. A resumable draft (below)
    // deliberately survives an accidental Escape / back-nav / reload.
    setInput("");
    setSending(false);
    setBusyProposal(null);
    setPendingClarifications(null);
    setRenegotiation(null);
    setBusyChoice(null);
    clearRenegotiation();
    setFocusToken(0);
    setSources([]);
    setPendingSourceIds([]);
    clearMarksRef.current = false;
    autoResumePendingRef.current = false;
    previousModeRef.current = { autoAnswer: initialAutoAnswer, grillMe: initialGrillMe };
    setRefiningProposal(null);
    setRejectingProposal(null);
    setAutoAnswer(initialAutoAnswer);
    setGrillMe(initialGrillMe);
    setShowDraftPrompt(false);
    editSentRef.current = false;

    if (isEdit) {
      // Editing continues the goal's own Add-goal conversation, so the coach still holds the exchange
      // that produced the plan being refined. It starts from the current goal and its milestones, not
      // from a draft — the draft bucket belongs to a goal that has not been created yet.
      setActiveCategory(goal?.life_area || null);
      setStep("chat");
      setHeldFirst(null);
      setPlanConfirmed(false);
      setFinalStatus("");
      reusedDraftRef.current = false;
      setMessages([]);
      // `goal_thread` answers the conversation's real bucket ref, which is what keeps this edit in the
      // same thread. With no thread it answers the goal id, which is the server's deterministic bucket.
      refIdRef.current = goal.id;
      api
        .goalThread(goal.id)
        .then((thread) => {
          if (cancelled) return;
          if (thread?.ref_id) refIdRef.current = thread.ref_id;
          setMessages(thread?.messages || []);
          if (!editSentRef.current) {
            editSentRef.current = true;
            sendRef.current?.(EDIT_OPEN_MESSAGE);
          }
        })
        .catch(() => {
          if (cancelled) return;
          if (!editSentRef.current) {
            editSentRef.current = true;
            sendRef.current?.(EDIT_OPEN_MESSAGE);
          }
        });
      return () => { cancelled = true; };
    }

    const saved = readDraftBucket("add_goal");
    if (saved) {
      // Resume the draft minted earlier this app session: reuse its bucket and
      // restore the transcript + proposal cards from history.
      refIdRef.current = saved;
      reusedDraftRef.current = true;
      setShowDraftPrompt(false);
      api
        .history({ refId: saved, kind: "add_goal", scope: "goal" })
        .then((m) => {
          if (cancelled) return;
          const list = m || [];
          if (list.length > 0) {
            setMessages(list);
            setStep("chat");
            setShowDraftPrompt(true);
          } else {
            setMessages([]);
            setActiveCategory(null);
            setStep(INITIAL_STEP);
    setHeldFirst(null);
    setPlanConfirmed(false);
    setFinalStatus("");
          }
        })
        .catch(() => {
          if (cancelled) return;
          setMessages([]);
          setActiveCategory(null);
          setStep(INITIAL_STEP);
    setHeldFirst(null);
    setPlanConfirmed(false);
    setFinalStatus("");
        });
    } else {
      // Fresh draft — mint a bucket and remember it for the session.
      setMessages([]);
      setActiveCategory(null);
      setStep(INITIAL_STEP);
    setHeldFirst(null);
    setPlanConfirmed(false);
    setFinalStatus("");
      reusedDraftRef.current = false;
      refIdRef.current = `new_goal_${crypto.randomUUID()}`;
      writeDraftBucket("add_goal", refIdRef.current);
    }
    return () => { cancelled = true; };
    // `goal` is a fresh object on every parent render; its id is the identity that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialAutoAnswer, initialGrillMe, isEdit, goal?.id]);

  const applyPlan = useCallback((result, { streamId }) => {
    const finalize = (patch) =>
      setMessages((prev) =>
        prev.map((message) =>
          message.id === streamId ? { ...message, streaming: false, ...patch } : message,
        ),
      );

    if (result.status === "ok") {
      finalize({
        id: result.message_id,
        content: result.prose || "",
        proposals: result.proposals || [],
      });
    } else if (result.status === "clarify") {
      finalize({ id: result.message_id, content: result.prose || "A few details first:" });
      setPendingClarifications({
        messageId: result.message_id,
        prompt: result.prose || "",
        questions: result.questions || [],
      });
    } else if (result.status === "renegotiate") {
      finalize({ id: result.message_id, content: result.prose || "" });
      setRenegotiation({ headroom: result.headroom, options: result.options || [] });
    } else {
      finalize({ id: result.message_id, content: result.prose || "No changes needed." });
    }
  }, []);

  const { tryPlan } = usePlanSend({
    kind: "add_goal",
    scope: "goal",
    refIdRef,
    title: activeCategory ? `${activeCategory} goal` : "Add a new goal",
    helperText: "Build a realistic, source-grounded plan for this goal.",
    autoAnswer,
    grillMe,
    sources,
    setMessages,
    applyPlan,
  });

  const send = async (text, { showUser = true } = {}) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setInput("");
    const localUserId = `local_${Date.now()}`;
    const streamId = `stream_${++streamIdRef.current}`;
    setMessages((prev) => [
      ...prev,
      // Auto re-plans (source attached mid-plan) run without a fabricated
      // "You" bubble — only the coach's rebuilt proposal is shown.
      ...(showUser ? [{ id: localUserId, role: "user", content: trimmed, proposals: [] }] : []),
      { id: streamId, role: "assistant", content: "", proposals: [], streaming: true },
    ]);

    try {
      // An edit always goes through the coach: the typed planner pipeline has no edit mode, and would
      // propose a new goal from the same message. `edit_goal` tells the coach to revise this one.
      const handled = isEdit ? false : await tryPlan(trimmed, streamId);
      if (handled) return;
      const resp = await fetch(`${API}/chat/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          auto_answer: autoAnswer,
          clarify: grillMe,
          proactive_propose: autoAnswer && !grillMe,
          // Operation-scoped context (spec §10.3) — same refId for
          // every turn in this bucket.
          scope: "goal",
          refId: refIdRef.current,
          kind: "add_goal",
          // Prompt mode, not a bucket: the conversation stays `add_goal` (so it is the same thread),
          // but the coach is told to revise this goal instead of proposing another.
          edit_goal: isEdit || undefined,
          // Current-conversation attachments — server injects the stored
          // text excerpts into the prompt.
          sourceIds: sources.map((s) => s.id),
        }),
      });
      if (!resp.ok || !resp.body) throw new Error("stream failed");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finalId = null;

      const handle = (data) => {
        if (data.type === "status") {
          setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, status: data.content } : m)));
        } else if (data.type === "delta") {
          setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, content: m.content + data.content } : m)));
        } else if (data.type === "tools") {
          finalId = data.message_id;
          setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, id: data.message_id, proposals: data.proposals } : m)));
        } else if (data.type === "needs_clarification") {
          finalId = data.message_id;
          setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, id: data.message_id, streaming: false } : m)));
          setPendingClarifications({
            messageId: data.message_id,
            prompt: data.prompt,
            questions: data.questions || [],
          });
        } else if (data.type === "impact") {
          // Structured impact block (spec §10.6) — attach to the
          // assistant message that produced it.
          setMessages((prev) => prev.map((m) => (m.id === (finalId || streamId) ? { ...m, impact: data.impact } : m)));
        } else if (data.type === "done") {
          // Defensive redirect (spec §10.2) — server detected we sent
          // to a closed bucket and minted a fresh one.
          if (data.redirected && data.ref_id) refIdRef.current = data.ref_id;
          setMessages((prev) => prev.map((m) => (m.id === (finalId || streamId) ? { ...m, id: data.message_id, streaming: false } : m)));
        } else if (data.type === "error") {
          setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, streaming: false, content: m.content || "(no response)" } : m)));
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (raw.startsWith("data: ")) { try { handle(JSON.parse(raw.slice(6))); } catch {} }
        }
      }
    } catch {
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    } finally {
      setSending(false);
      // The message just sent already carried every attachment via `sourceIds`,
      // so nothing is left for "Update plan with N sources" to send.
      setPendingSourceIds([]);
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    }
  };

  sendRef.current = send;
  useEffect(() => {
    const switchedToAuto = autoAnswer && !previousModeRef.current.autoAnswer;
    previousModeRef.current = { autoAnswer, grillMe };
    if (switchedToAuto && (pendingClarifications || sending)) {
      autoResumePendingRef.current = true;
    }
    if (autoAnswer && autoResumePendingRef.current && pendingClarifications && !sending) {
      autoResumePendingRef.current = false;
      setPendingClarifications(null);
      sendRef.current?.("Proceed with reasonable assumptions for anything unanswered and make the plan now.");
    } else if (!sending && !pendingClarifications) {
      autoResumePendingRef.current = false;
    }
  }, [autoAnswer, grillMe, pendingClarifications, sending]);

  // "Make changes" was sent: the moment the coach's next proposal stops
  // streaming, clear the marks on the previous cards. They were the input to
  // that proposal, so keeping them marked would look like unsent edits.
  useEffect(() => {
    if (!clearMarksRef.current) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || last.streaming) return;
    clearMarksRef.current = false;
    setMessages((prev) =>
      prev.map((m) => ({
        ...m,
        proposals: (m.proposals || []).map((p) =>
          p.refinement || p.rejection || p.status === "rejected"
            ? { ...p, refinement: "", rejection: "", status: "pending" }
            : p,
        ),
      })),
    );
  }, [messages]);

  const onUpdatePlanSources = () => {
    const names = sources
      .filter((s) => pendingSourceIds.includes(s.id))
      .map((s) => s.original_filename || s.url);
    if (names.length === 0) return;
    send(sourceUpdateMessage(names));
  };

  const onRenegotiationChoice = (choice) => {
    setBusyChoice(choice);
    setRenegotiation(null);
    const streamId = `stream_${++streamIdRef.current}`;
    setMessages((prev) => [
      ...prev,
      { id: streamId, role: "assistant", content: "", proposals: [], streaming: true },
    ]);
    tryPlan(renegotiationChoiceLabel(choice), streamId).finally(() => setBusyChoice(null));
  };

  const closeRenegotiation = () => {
    setRenegotiation(null);
    clearRenegotiation();
  };

  const buildMessage = () => {
    // Iteration 5 (Issue 8) — never auto-send a canned prompt. If the
    // textarea is empty, send the category label so the coach still has
    // a noun to anchor on, but no fabricated user voice. Returning ""
    // here would short-circuit the send and the user would wonder why
    // Enter did nothing.
    const text = (input || "").trim();
    if (text) return text;
    const cat = CATEGORIES.find((c) => c.id === activeCategory);
    return cat ? `I want to set a ${cat.label.toLowerCase()} goal.` : "";
  };

  const handleSend = () => {
    const msg = buildMessage();
    if (!msg) return;
    // The first message opens with "anything to attach?" so sources can shape the questions. An edit
    // is about the plan that already exists, so it goes straight to the coach.
    if (!isEdit && messages.length === 0 && sources.length === 0 && heldFirst === null) {
      setHeldFirst(msg);
      setInput("");
      return;
    }
    send(msg);
  };

  const releaseHeldFirst = () => {
    const msg = heldFirst;
    setHeldFirst(null);
    setPlanConfirmed(false);
    setFinalStatus("");
    if (msg) send(msg);
  };

  const pickCategory = (cat) => {
    // Always select the tapped category and enter the chat. The old
    // toggle-off (`isActive ? null : cat.id`) meant that returning to
    // the tiles step with a category still active made a second tap
    // DESELECT it instead of re-opening that category's chat — the
    // user had to tap twice. There's no deselect use case here: the
    // "Change category" control is the way back.
    setActiveCategory(cat.id);
    enterChat();
  };

  const goBackToTiles = () => {
    setStep(INITIAL_STEP);
    setHeldFirst(null);
    setPlanConfirmed(false);
    setFinalStatus("");
    setInput("");
  };

  // Step-aware back: when called from the parent's back button while
  // we're in the chat step, retreat to the tiles step (keeping the
  // active category selected). When called from the tiles step, fall
  // through to onClose so the dialog closes. The parent's back
  // handler always calls this — it doesn't need to know the current
  // step.
  const handleStepBack = () => {
    // An edit has no tiles step to retreat to: closing is the only layer behind the chat.
    if (!isEdit && step === "chat" && activeCategory) {
      goBackToTiles();
    } else {
      onClose?.();
    }
  };
  // Keep the ref current so useDialogBack always sees the latest step.
  useEffect(() => {
    stepBackRef.current = handleStepBack;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, onClose]);

  // Expose handleStepBack to the parent via the optional `onStepBack`
  // prop. Coach.js's back button can call this directly (skipping
  // the closer stack) so the retreat is immediate. If the parent
  // doesn't pass `onStepBack`, the closer-stack fallback still works.
  useEffect(() => {
    if (typeof onStepBack === "function") onStepBack(handleStepBack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, onStepBack]);

  // True when the transcript already holds a confirmable plan. Attaching a
  // source in that state should rebuild the plan so its insights shape the
  // goal/milestones/tasks — not just ground the (already-sent) proposal.
  const hasPlanOnScreen = messages.some(
    (m) =>
      m.role === "assistant" &&
      !m.streaming &&
      (m.proposals || []).some(
        (p) => (p.status || "pending") === "pending" && p.action !== "ask" && p.action !== "navigate",
      ),
  );

  const handleUploadFile = async (file) => {
    try {
      // Coach.uploadFile returns the created server source — use its real
      // id so the chip's X deletes it server-side instead of a local stub.
      const created = await onUploadSource(file, "", { temporary: true });
      if (!created?.id) return;
      setSources((prev) => [
        ...prev,
        {
          id: created.id,
          kind: "file",
          original_filename: created.original_filename || file.name,
          url: created.url || file.name,
        },
      ]);
      // A plan on screen does not re-plan by itself any more: collect the source
      // so the user can add several of every kind first, then update once.
      if (hasPlanOnScreen) setPendingSourceIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
    } catch {}
  };

  const handleAddLink = async (url, goalId = "", options = {}) => {
    try {
      const created = await onAddLink(url, "", { temporary: true, ...options });
      if (!created?.id) return;
      setSources((prev) => [
        ...prev,
        {
          id: created.id,
          kind: "link",
          original_filename: created.original_filename || url,
          url: created.url || url,
        },
      ]);
      if (hasPlanOnScreen) setPendingSourceIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
    } catch {}
  };

  const handleDeleteSource = (id) => {
    setSources((prev) => prev.filter((s) => s.id !== id));
    setPendingSourceIds((prev) => prev.filter((sourceId) => sourceId !== id));
    onDeleteSource(id);
  };

  const confirm = async (messageId, proposalId) => {
    // One confirm at a time: the control is disabled from the tap until the reply arrives, and a
    // second tap (same frame, or from the card while the pinned button is in flight) does nothing.
    if (confirmingRef.current) return;
    const plan = messages.find((message) => message.id === messageId)?.proposals || [];
    const pending = plan.filter(
      (proposal) =>
        (proposal.status || "pending") === "pending" &&
        proposal.action !== "ask" &&
        proposal.action !== "navigate",
    );
    if (pending.length === 0) return;
    // One Add-goal plan, one goal. When the coach's reply carries more than one `create_goal`
    // (a repeat, or a refined copy beside the original), only the newest pending one across the
    // conversation is confirmed. Earlier goal cards are marked "superseded", not confirmed, so
    // they cannot create a second goal. The coach drops them at the source and the server skips
    // duplicates in a batch; this is the client's path for a plan already on screen.
    const newestGoal = newestPendingCreateGoal(messages);
    const superseded = pending.filter(
      (proposal) => proposal.action === "create_goal" && proposal.id !== newestGoal?.id,
    );
    const toConfirm = pending.filter(
      (proposal) => !superseded.some((dropped) => dropped.id === proposal.id),
    );
    if (superseded.length > 0) {
      const supersededSet = new Set(superseded.map((proposal) => proposal.id));
      setMessages((prev) =>
        prev.map((message) => ({
          ...message,
          proposals: (message.proposals || []).map((item) =>
            supersededSet.has(item.id) ? { ...item, status: "superseded" } : item,
          ),
        })),
      );
    }
    confirmingRef.current = true;

    let freshState = null;
    const confirmedIds = [];
    setSending(true);
    setFinalStatus(CONFIRM_STATUS.saving(0, toConfirm.length));
    try {
      // One batched, transactional call: the server applies the goal first, then its milestones, and
      // either all of them land or none do (it used to be one request per item, ~7 x 6s).
      const ordered = [...toConfirm].sort((a, b) =>
        Number(b.action === "create_goal") - Number(a.action === "create_goal"),
      );
      setBusyProposal(ordered[0].id);
      const resp = await api.confirmBatch(messageId, ordered.map((p) => p.id));
      freshState = resp?.state || freshState;
      confirmedIds.push(...ordered.map((p) => p.id));
      // Finalized: the goal exists now, so drop the resumable draft.
      // Without this, reopening Add Goal replays the old transcript and
      // wrongly offers "You have an unfinished plan from earlier."
      if (ordered.some((p) => p.action === "create_goal")) clearDraftBucket("add_goal");
      const confirmedSet = new Set(confirmedIds);
      setMessages((prev) =>
        prev.map((message) =>
          message.id !== messageId
            ? message
            : {
                ...message,
                proposals: message.proposals.map((item) =>
                  confirmedSet.has(item.id) ? { ...item, status: "confirmed" } : item,
                ),
              },
        ),
      );

      const createdProposal = ordered.find((proposal) => proposal.action === "create_goal");
      const createdGoalTitle = createdProposal?.args?.title || goal?.title || "your new goal";
      let createdGoalId = goal?.id;
      if (!isEdit) {
        // By title first; if the server stored a different title, the newest active goal is the one just made.
        const activeGoals = (freshState?.goals || []).filter((item) => item.status === "active");
        createdGoalId = (activeGoals.filter((item) => item.title === createdGoalTitle).at(-1) || activeGoals.at(-1))?.id;
      }
      // The goal exists (or, for an edit, has changed): show it on the board at once. Its card then says
      // what the coach is doing (below) instead of the goal appearing only when everything is finished.
      onGoalConfirmed?.(freshState);
      // Build the schedule in the background: it takes minutes, and the goal card shows the coach working on
      // it, so the dialog does not hold the user. The board is re-read when it ends (lib/goalPlanning).
      // An edit is the exception: `/tools/confirm` re-plans the goal's sessions inside the confirm request,
      // behind the build lease, so starting a second build here would be two writers over the same rows.
      if (!isEdit && createdGoalId) buildSchedule({ id: createdGoalId, title: createdGoalTitle });
      setMessages((prev) => [
        ...prev,
        {
          id: `success_${Date.now()}`,
          role: "success",
          content: `${isEdit ? "Updated" : "Created"} "${createdGoalTitle}" and confirmed ${confirmedIds.length} plan item${confirmedIds.length === 1 ? "" : "s"}`,
          goalId: createdGoalId,
          goalTitle: createdGoalTitle,
          createdAt: new Date().toISOString(),
        },
      ]);
      setPlanConfirmed(true);
      setFinalStatus(CONFIRM_STATUS.done(createdGoalTitle));
      setTimeout(() => onClose?.(), CLOSE_AFTER_CONFIRM_MS);
    } catch (e) {
      setFinalStatus("");
      if (confirmedIds.length > 0) onGoalConfirmed?.(freshState);
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't confirm the full plan. Retry to finish it.");
    } finally {
      setSending(false);
      setBusyProposal(null);
      confirmingRef.current = false;
    }
  };

  const reject = (messageId, proposalId, reason) => {
    // Local-only: mark rejected + store the reason, and CLEAR any
    // refinement (a card is either refined or rejected, never both). The
    // pinned "Refine goals" button applies everything at once.
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              proposals: m.proposals.map((p) =>
                p.id === proposalId
                  ? { ...p, status: "rejected", rejection: reason || "", refinement: "" }
                  : p,
              ),
            }
          : m,
      ),
    );
  };

  // Refine / Reject modal handlers (Iteration 9).
  // The proposal object passed in carries enough context (action +
  // title) to label the modals; the messageId is looked up from the
  // messages state.
  const findProposalMessageId = (proposal) => {
    for (const m of messages) {
      if ((m.proposals || []).some((p) => p.id === proposal.id)) return m.id;
    }
    return null;
  };

  // One line per proposal carrying its CURRENT values, so the re-propose knows
  // exactly what changed from what — not just a bare note.
  const describeProposal = (p) => {
    const a = p.args || {};
    const fields = [
      a.title && `title="${a.title}"`,
      a.target_date && `target_date=${a.target_date}`,
      a.horizon && `horizon=${a.horizon}`,
      a.description && `description="${a.description}"`,
      a.why && `why="${a.why}"`,
      a.first_action && `first_action="${a.first_action}"`,
    ].filter(Boolean);
    return `${(p.action || "change").replace(/_/g, " ")}${fields.length ? ` — current: ${fields.join(", ")}` : ""}`;
  };

  // The latest plan is the one the marks live on. Every card's CURRENT values
  // go in, so the coach re-plans from what is on screen rather than from its
  // memory of the first draft.
  const latestPlanMessage = () => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && !m.streaming && (m.proposals || []).length > 0) return m;
    }
    return null;
  };

  // One message for every marked card. It carries the whole current plan,
  // which cards were refined (with the note) and which were removed.
  const buildChangeMessage = () => {
    const ps = (latestPlanMessage()?.proposals || []).filter(
      (p) => p.action !== "ask" && p.action !== "navigate",
    );
    if (ps.length === 0) return "";
    const refinements = [];
    const rejections = [];
    for (const p of ps) {
      if (p.refinement) refinements.push(`- ${describeProposal(p)} → change to: ${p.refinement}`);
      if (p.status === "rejected") {
        rejections.push(`- ${describeProposal(p)}${p.rejection ? ` → reason: ${p.rejection}` : ""}`);
      }
    }
    if (!refinements.length && !rejections.length) return "";

    const lines = ["Current plan:", ...ps.map((p) => `- ${describeProposal(p)}`)];
    if (refinements.length) {
      lines.push("", "Refine these:", ...refinements);
    }
    if (rejections.length) {
      lines.push("", refinements.length ? "Remove these:" : "Remove these and keep the rest:", ...rejections);
    }
    const request = refinements.length ? CHANGE_REQUEST : REMOVE_ONLY_REQUEST;
    return `${request}\n\n${lines.join("\n")}`;
  };

  const onOpenRefine = (proposal) => {
    setRefiningProposal(proposal);
  };
  const onOpenReject = (proposal) => {
    setRejectingProposal(proposal);
  };

  const submitRefine = (thought) => {
    if (!refiningProposal) return;
    // Marking only marks. The note is stored on the card (a card is either
    // refined or rejected, never both) and nothing is sent until the user
    // presses "Make changes", so they can mark several cards first.
    const id = refiningProposal.id;
    setMessages((prev) =>
      prev.map((m) => ({
        ...m,
        proposals: (m.proposals || []).map((p) =>
          p.id === id ? { ...p, refinement: thought, rejection: "", status: "pending" } : p,
        ),
      })),
    );
  };

  // Revert: clear the saved refinement / rejection from a card.
  const clearRefine = () => {
    if (!refiningProposal) return;
    const id = refiningProposal.id;
    setMessages((prev) =>
      prev.map((m) => ({
        ...m,
        proposals: (m.proposals || []).map((p) => (p.id === id ? { ...p, refinement: "" } : p)),
      })),
    );
  };
  const clearReject = () => {
    if (!rejectingProposal) return;
    const id = rejectingProposal.id;
    setMessages((prev) =>
      prev.map((m) => ({
        ...m,
        proposals: (m.proposals || []).map((p) =>
          p.id === id ? { ...p, rejection: "", status: "pending" } : p,
        ),
      })),
    );
  };

  // Drop every mark without sending anything: the plan goes back to Confirm.
  const discardChanges = () => {
    clearMarksRef.current = false;
    setMessages((prev) =>
      prev.map((m) => ({
        ...m,
        proposals: (m.proposals || []).map((p) =>
          p.refinement || p.rejection || p.status === "rejected"
            ? { ...p, refinement: "", rejection: "", status: "pending" }
            : p,
        ),
      })),
    );
  };

  const submitReject = async (reason) => {
    if (!rejectingProposal) return;
    const messageId = findProposalMessageId(rejectingProposal);
    if (!messageId) {
      throw new Error("Couldn't find the original proposal to reject.");
    }
    // A rejection removes the card and nothing else. It used to ask the coach to "drop or rework" it,
    // which re-planned the whole goal (5 changes became 7, and the title drifted between drafts). The
    // remaining cards are confirmed as they are; a refinement is the way to ask for a rework.
    await reject(messageId, rejectingProposal.id, reason);
  };

  const clearChat = async () => {
    setMessages([]);
    setInput("");
    setPendingClarifications(null);
  };

  // Iteration 9 — Confirm / Recreate pinned button. Logic:
  //   - input is empty (user hasn't typed anything — refining takes over)
  //   - latest assistant message has at least one pending create_goal proposal
  //   - if any pending add_milestone proposal is in the same message
  //     → button label = "Confirm" (we have a full goal + milestones)
  //   - else → button label = "Recreate goals & milestones" (re-ask the
  //     coach to bundle milestones into the next proposal)
  //
  // The button is a thin override on top of ToolConfirmationPrompt: the
  // existing Confirm / Refine / Reject buttons inside the proposal card
  // stay so a user with a mouse can still act inline.
  const pinnedAction = (() => {
    if (input.trim().length > 0) return null;
    if (sending) return null;
    // Find the latest assistant message with proposals.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant" || m.streaming) continue;
      const proposals = m.proposals || [];
      if (proposals.length === 0) continue;

      // Priority 1 — any marked change (a refinement or a rejection) is sent
      // first, all at once: the coach re-plans around every mark, and the user
      // confirms that new plan, not the old one.
      const refined = proposals.filter((p) => p.refinement || p.status === "rejected");
      const changedCount = refined.length;
      if (changedCount > 0) {
        return {
          messageId: m.id,
          proposalId: null,
          label: `Make changes (${changedCount})`,
          variant: "make_changes",
          proposals,
        };
      }

      const pending = proposals.filter(
        (p) =>
          (p.status || "pending") === "pending" &&
          p.action !== "ask" &&
          p.action !== "navigate",
      );
      const hasCreateGoal = pending.some((p) => p.action === "create_goal");

      if (hasCreateGoal) {
        const hasMilestones = pending.some((p) => p.action === "add_milestone");
        const createProposal = pending.find((p) => p.action === "create_goal");
        return {
          messageId: m.id,
          proposalId: createProposal.id,
          label: hasMilestones
            ? confirmLabel(pending.length, proposals.filter((p) => p.status === "rejected").length)
            : "Recreate goals & milestones",
          variant: hasMilestones ? "confirm" : "recreate",
        };
      }

      if (pending.length > 0) {
        return {
          messageId: m.id,
          proposalId: null,
          label: isEdit
            ? `Confirm the updated plan (${pending.length})`
            : `Confirm remaining plan items (${pending.length})`,
          variant: "confirm_all",
        };
      }

      // No pending create_goal — everything was rejected / refined away,
      // or the plan is milestones-only. Offer a redefine from scratch.
      return {
        messageId: m.id,
        proposalId: null,
        label: "Redefine goals & milestones",
        variant: "redefine",
      };
    }
    return null;
  })();

  const onPinnedAction = () => {
    if (!pinnedAction) return;

    if (pinnedAction.variant === "make_changes") {
      // One message for every marked card. Marks are cleared once the coach's
      // next proposal lands (the effect above).
      const msg = buildChangeMessage();
      if (!msg) return;
      clearMarksRef.current = true;
      send(msg);
      return;
    }

    if (pinnedAction.variant === "confirm" || pinnedAction.variant === "confirm_all") {
      confirm(pinnedAction.messageId, pinnedAction.proposalId);
      return;
    }
    if (pinnedAction.variant === "redefine") {
      send(
        isEdit
          ? "That plan needs reworking. Re-propose the whole plan for this goal — the goal and every open milestone, with target dates (smallest first step first). Keep the milestones already done fixed."
          : "Scrap that plan. Re-propose this goal from scratch — one goal, then 3-4 milestones with target dates (smallest first step first). Same category, same voice.",
      );
      return;
    }
    // Recreate — re-ask the coach to bundle milestones. An edit must include them: the batch is only
    // treated as a milestone replacement when the update arrives with the re-proposed set.
    send(
      isEdit
        ? "Your last proposal had no milestones. Re-propose the whole plan for this goal, with at least 3 milestones (target dates; smallest first step first). Keep the milestones already done fixed."
        : "Your last proposal was a goal with no milestones. Re-propose the SAME goal but bundle at least 3 milestones (with target dates; smallest first step first). Same voice, same why, same first action.",
    );
  };

  const startNewDraft = useCallback(() => {
    refIdRef.current = `new_goal_${crypto.randomUUID()}`;
    writeDraftBucket("add_goal", refIdRef.current);
    reusedDraftRef.current = false;
    setMessages([]);
    setPendingClarifications(null);
    setActiveCategory(null);
    setStep(INITIAL_STEP);
    setHeldFirst(null);
    setPlanConfirmed(false);
    setFinalStatus("");
    setShowDraftPrompt(false);
  }, []);

  const activeCat = CATEGORIES.find((c) => c.id === activeCategory);

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={Sparkles}
      title={
        isEdit
          ? "Edit goal"
          : step === "chat" && activeCat
          ? `${activeCat.label} goal`
          : "Add a new goal"
      }
      subtitle={
        isEdit
          ? `Refine "${goal?.title || "this goal"}" — say what should change and the coach re-proposes the whole plan.`
          : profileNeeded
          ? "A few quick things about your week, then your goal."
          : step === "tiles"
          ? "Pick what area this goal is in. You can refine the details once we start talking."
          : activeCat
          ? `Tell the coach about your ${activeCat.label.toLowerCase()} goal — or just hit send and they'll propose something.`
          : "Tell me in your own words — what do you want to achieve, and by when?"
      }
      maxWidth="max-w-3xl"
      testId="add-goal-dialog"
      // Always closable. This dialog is the first step of the guide, but it must never be a trap: a
      // guest has to be able to reach sign-in, and anyone may want to look around first. The empty
      // state's "Add your first goal" opens it again, so closing it costs nothing.
      dismissible
      // On mobile the dialog morphs:
      //   step 1 (tiles) — half-height sheet pinned to bottom
      //   step 2 (chat)  — full-height sheet so the composer gets the
      //                    screen real-estate + keyboard safe-area it
      //                    needs. On desktop this prop is ignored.
      fullHeightMobile={step === "chat"}
    >
      {/* Step 1: tiles. Step 2: a slim "change category" pill row + the
          ChatConsole. The same tiles collapse into a chip strip at the
          top of the chat — keeps the category visible without giving
          it a whole grid. */}
      {showDraftPrompt && (
        <div
          data-testid="draft-continue-prompt"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5"
        >
          <span className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--text-secondary)]">
            You have an unfinished plan from earlier.
          </span>
          <button
            type="button"
            data-testid="draft-continue"
            onClick={() => setShowDraftPrompt(false)}
            className="min-h-9 rounded-md border border-[var(--border)] px-3 text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          >
            Continue
          </button>
          <button
            type="button"
            data-testid="draft-start-new"
            onClick={startNewDraft}
            className="min-h-9 rounded-md bg-[var(--accent)] px-3 text-[12px] font-medium text-[var(--bg-primary)] hover:opacity-90"
          >
            Start new
          </button>
        </div>
      )}

      {profileNeeded && !isEdit ? (
        <AboutYouCard onSave={saveProfile} onSkip={saveProfile} />
      ) : step === "tiles" ? (
        <div
          data-testid="add-goal-categories"
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mb-4"
        >
          {CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.id;
            const { Icon, gradient, ring, glow } = cat;
            // "Something else" (custom) is the 7th tile in a 2-col mobile
            // grid — without this span it lands alone in row 4 looking
            // orphaned. Spanning both columns makes it the explicit
            // meta/catch-all it already is.
            const spanFullOnMobile = cat.id === "custom";
            return (
              <button
                key={cat.id}
                type="button"
                data-testid={`add-goal-category-${cat.id}`}
                onClick={() => pickCategory(cat)}
                aria-pressed={isActive}
                className={`relative flex flex-col items-start justify-between text-left rounded-xl border min-h-[112px] p-3.5 overflow-hidden transition-all group focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                  spanFullOnMobile ? "col-span-2 sm:col-span-1" : ""
                } ${
                  isActive
                    ? `border-transparent ring-1 ${ring} bg-gradient-to-br ${gradient}`
                    : `border-[var(--border)] bg-[var(--bg-primary)] hover:border-[var(--border-accent)] hover:-translate-y-0.5`
                }`}
              >
                {/* Gradient wash — only visible on active state, fades to
                    subtle on hover. */}
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${gradient} ${
                    isActive ? "opacity-100" : "opacity-0 group-hover:opacity-60"
                  } transition-opacity`}
                />
                {/* Soft glow halo at the top-left, intensifies on active. */}
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute -top-6 -left-6 h-20 w-20 rounded-full blur-2xl ${glow} ${
                    isActive ? "opacity-80" : "opacity-30 group-hover:opacity-50"
                  } transition-opacity`}
                />
                <Icon
                  className={`relative w-6 h-6 ${
                    isActive ? "text-[var(--text-primary)]" : "text-[var(--accent)] group-hover:text-[var(--text-primary)]"
                  } transition-colors`}
                  strokeWidth={1.6}
                />
                <span
                  className={`relative text-sm font-semibold leading-tight tracking-tight ${
                    isActive ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
                  } transition-colors`}
                >
                  {cat.label}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          {!isEdit && activeCategory && (
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              data-testid="add-goal-back-to-tiles"
              onClick={goBackToTiles}
              className="font-medium min-h-11 flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <ArrowLeft className="w-3 h-3" /> Change category
            </button>
          </div>
          )}

          {/* Isolated ChatConsole — own messages/sending/input, NOT
              shared with the left-hand console. "Same component,
              different context" as the user requested.
              showSources={false} hides the attach / link buttons —
              sources don't apply to a goal-add chat, and the no-op
              stubs were surfacing as a confusing dead UI. */}
          {/* The plan the edit starts from. Done milestones are shown but are not re-proposed: they
              record work already achieved, and the replacement keeps them untouched. */}
          {isEdit && (
            <div
              data-testid="edit-goal-plan"
              className="mb-3 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5"
            >
              <p className="text-[12px] font-semibold text-[var(--text-primary)]">
                {goal?.title}
                {goal?.target_date && <span className="font-normal text-[var(--text-muted)]"> · by {goal.target_date}</span>}
                {goal?.weekly_hours ? (
                  <span className="font-normal text-[var(--text-muted)]"> · {goal.weekly_hours}h/week</span>
                ) : null}
              </p>
              {(goal?.milestones || []).length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {(goal?.milestones || []).map((m) => {
                    const done = m.status === "done";
                    return (
                      <li
                        key={m.id}
                        className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]"
                      >
                        {done ? (
                          <Check className="w-3 h-3 shrink-0 text-[var(--success)]" aria-hidden="true" />
                        ) : (
                          <span className="w-3 shrink-0" aria-hidden="true" />
                        )}
                        <span className={done ? "line-through text-[var(--text-muted)]" : ""}>{m.title}</span>
                        {m.target_date && (
                          <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">{m.target_date}</span>
                        )}
                        {done && <span className="text-[10px] uppercase tracking-wide text-[var(--success)]">done</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {heldFirst !== null && (
            <div className="mb-3">
              <p className="mb-3 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]">{heldFirst}</p>
              <SourcesAskCard
                sources={sources}
                onUploadFile={handleUploadFile}
                onAddLink={handleAddLink}
                onDeleteSource={handleDeleteSource}
                onContinue={releaseHeldFirst}
                goalContext={heldFirst}
              />
            </div>
          )}
          <div className={`flex-1 min-h-0 -mx-5 sm:mx-0 border-t border-[var(--border)] flex flex-col ${heldFirst !== null ? "hidden" : ""}`}>
            <ChatConsole
              key={focusToken}
              messages={messages}
              onSend={handleSend}
              sending={sending}
              input={input}
              setInput={setInput}
              onConfirm={confirm}
              onReject={(messageId, proposalId) => {
                // Reject now flows through the modal. The actual reject
                // call happens in `submitReject` (below) once the modal
                // closes. Here we just stash the proposal so the modal
                // knows which one to ask about.
                const proposal = messages
                  .find((m) => m.id === messageId)
                  ?.proposals?.find((p) => p.id === proposalId);
                if (proposal) setRejectingProposal(proposal);
              }}
              onOpenRefine={onOpenRefine}
              onOpenReject={onOpenReject}
              onAnswerChoice={(text) => send(text)}
              busyProposal={busyProposal}
              autoAnswer={autoAnswer}
              setAutoAnswer={setAutoAnswer}
              grillMe={grillMe}
              setGrillMe={setGrillMe}
              onUploadFile={handleUploadFile}
              onAddLink={handleAddLink}
              sources={sources}
              onDeleteSource={handleDeleteSource}
              onClearChat={clearChat}
              pendingClarifications={pendingClarifications}
              onAnswerClarification={(text) => { setPendingClarifications(null); send(text); }}
              onDismissClarifications={() => setPendingClarifications(null)}
              // Links, files (PDFs and documents) and photos stay available at
              // every stage of Add Goal: before the first plan, while one is on
              // screen, and after refining. The picker takes several files at
              // once so a batch can be attached before a single update.
              showSources={true}
              sourceAccept={SOURCE_FILE_ACCEPT}
              allowMultipleSources
              sourceLabel={sourceChipLabel}
              readOnly={planConfirmed || !!finalStatus}
              readOnlyNote={finalStatus}
              focusOnMount={true}
              goalContext={
                isEdit
                  ? `Editing "${goal?.title || "this goal"}"`
                  : activeCategory
                  ? `Adding a "${activeCategory}" goal`
                  : "Adding a new goal"
              }
              // AddGoalDialog uses its own pinned Confirm button; suppress
              // the per-item Confirm so there aren't two confirm paths.
              showConfirm={false}
            />
            {/* Sources attached while this plan is on screen. They wait here
                until the user has added as many as they want of every kind,
                then one tap sends all of them together. */}
            {pendingSourceIds.length > 0 && (
              <div className="shrink-0 px-4 sm:px-5 pt-1 bg-[var(--bg-primary)]">
                <button
                  data-testid="update-plan-sources"
                  onClick={onUpdatePlanSources}
                  disabled={sending}
                  className="w-full h-11 rounded-full inline-flex items-center justify-center gap-2 border border-[var(--border-accent)] text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="w-4 h-4" aria-hidden="true" />
                  )}
                  Update plan with {pendingSourceIds.length} source
                  {pendingSourceIds.length === 1 ? "" : "s"}
                </button>
              </div>
            )}
            {/* Iteration 9 — Confirm / Recreate pinned button. Renders
                below the chat console's composer, inside the dialog so
                it stays visible at the bottom of the sheet even when
                the chat log is scrolled to the top. Hides the moment
                the user types (refining takes over via Enter). */}
            {pinnedAction && (
              <div
                data-testid={`pinned-action-${pinnedAction.variant}`}
                className="shrink-0 px-4 sm:px-5 pt-1 pb-2 bg-[var(--bg-primary)]"
              >
                {(() => {
                  const busy =
                    sending ||
                    (pinnedAction.proposalId != null && busyProposal === pinnedAction.proposalId);
                  const isPrimary =
                    pinnedAction.variant === "confirm" ||
                    pinnedAction.variant === "confirm_all" ||
                    pinnedAction.variant === "make_changes";
                  return (
                    <>
                      <button
                        data-testid="pinned-action-button"
                        onClick={onPinnedAction}
                        disabled={busy}
                        aria-busy={busy}
                        className={`w-full h-12 rounded-full inline-flex items-center justify-center gap-2 text-[15px] font-semibold transition-opacity disabled:opacity-60 hover:opacity-90 active:scale-[0.99] ${
                          isPrimary
                            ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                            : "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                        }`}
                      >
                        {busy ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                            {pinnedAction.variant === "make_changes" ? "Sending…" : "Confirming…"}
                          </>
                        ) : pinnedAction.variant === "confirm" || pinnedAction.variant === "confirm_all" ? (
                          <>
                            <Check className="w-4 h-4" aria-hidden="true" />
                            {pinnedAction.label}
                          </>
                        ) : pinnedAction.variant === "make_changes" ? (
                          <>
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                            {pinnedAction.label}
                          </>
                        ) : (
                          <>
                            <RefreshCw className="w-4 h-4" aria-hidden="true" />
                            {pinnedAction.label}
                          </>
                        )}
                      </button>
                      {pinnedAction.variant === "make_changes" && (
                        <button
                          data-testid="pinned-action-discard"
                          onClick={discardChanges}
                          disabled={busy}
                          className="mt-1 w-full h-11 rounded-full text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                        >
                          Discard changes
                        </button>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
          <RenegotiationDialog
            open={!!renegotiation}
            onClose={closeRenegotiation}
            headroom={renegotiation?.headroom}
            options={renegotiation?.options || []}
            busyOption={busyChoice}
            onChoose={onRenegotiationChoice}
          />
          <RefineModal
            open={!!refiningProposal}
            onClose={() => setRefiningProposal(null)}
            proposalTitle={refiningProposal?.args?.title || refiningProposal?.title || refiningProposal?.args?.goal_title || ""}
            proposalAction={(refiningProposal?.action || "change").replace(/_/g, " ")}
            proposalActionKey={refiningProposal?.action || ""}
            initialValue={refiningProposal?.refinement || ""}
            // Add Goal marks first and sends all the marks together, so the
            // note is not re-planned on save.
            subtitle={`What should change about this ${(refiningProposal?.action || "change").replace(/_/g, " ")}? Mark as many cards as you like, then tap Make changes.`}
            onSubmit={submitRefine}
            onClear={clearRefine}
          />
          <RejectModal
            open={!!rejectingProposal}
            onClose={() => setRejectingProposal(null)}
            proposalTitle={rejectingProposal?.args?.title || rejectingProposal?.title || rejectingProposal?.args?.goal_title || ""}
            proposalActionKey={rejectingProposal?.action || ""}
            initialValue={rejectingProposal?.rejection || ""}
            onSubmit={submitReject}
            onClear={clearReject}
          />
        </>
      )}
    </CenteredDialog>
  );
}
