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
} from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import ChatConsole from "./ChatConsole";
import RefineModal from "./RefineModal";
import RejectModal from "./RejectModal";
import RenegotiationDialog from "./RenegotiationDialog";
import { useDialogBack } from "../hooks/useDialogBack";
import { usePlanSend, renegotiationChoiceLabel, clearRenegotiation } from "../hooks/use-plan-send";
import { toast } from "sonner";
import { api, API } from "../lib/api";

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
export default function AddGoalDialog({
  open,
  onClose,
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
  const streamIdRef = useRef(0);
  // Operation-scoped context (spec §10) — the current conversation
  // bucket. Minted fresh on every dialog open; swapped only on
  // confirm (server pre-mints the next bucket) or when the server's
  // `done` event reports a defensive redirect off a closed bucket.
  const refIdRef = useRef(`new_goal_${crypto.randomUUID()}`);

  // UI state for the 2-step flow.
  const [activeCategory, setActiveCategory] = useState(null);
  const [step, setStep] = useState("tiles"); // "tiles" | "chat"
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
  const autoResumePendingRef = useRef(false);
  const previousModeRef = useRef({ autoAnswer: initialAutoAnswer, grillMe: initialGrillMe });
  const sendRef = useRef(null);

  useEffect(() => {
    if (open) {
      // Hard reset on every open — founder feedback (Iteration 9+):
      // if the user opened refine / reject, closed the dialog via the
      // back button without dismissing those, and re-opened, state
      // was leaking (chat step was preserved, category was preserved).
      // Reset EVERYTHING that could carry across opens.
      setMessages([]);
      setInput("");
      setSending(false);
      setBusyProposal(null);
      setPendingClarifications(null);
      setRenegotiation(null);
      setBusyChoice(null);
      clearRenegotiation();
      setActiveCategory(null);
      setStep("tiles");
      setFocusToken(0);
      setSources([]);
      autoResumePendingRef.current = false;
      previousModeRef.current = { autoAnswer: initialAutoAnswer, grillMe: initialGrillMe };
      setRefiningProposal(null);
      setRejectingProposal(null);
      setAutoAnswer(initialAutoAnswer);
      setGrillMe(initialGrillMe);
      // Fresh conversation bucket per open — the previous (possibly
      // unfinalized) goal's history must not leak into this session.
      refIdRef.current = `new_goal_${crypto.randomUUID()}`;
    }
  }, [open, initialAutoAnswer, initialGrillMe]);

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

  const send = async (text) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setInput("");
    const localUserId = `local_${Date.now()}`;
    const streamId = `stream_${++streamIdRef.current}`;
    setMessages((prev) => [
      ...prev,
      { id: localUserId, role: "user", content: trimmed, proposals: [] },
      { id: streamId, role: "assistant", content: "", proposals: [], streaming: true },
    ]);

    try {
      const handled = await tryPlan(trimmed, streamId);
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
        if (data.type === "delta") {
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
    send(msg);
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
    setStep("tiles");
    setInput("");
  };

  // Step-aware back: when called from the parent's back button while
  // we're in the chat step, retreat to the tiles step (keeping the
  // active category selected). When called from the tiles step, fall
  // through to onClose so the dialog closes. The parent's back
  // handler always calls this — it doesn't need to know the current
  // step.
  const handleStepBack = () => {
    if (step === "chat") {
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
          original_filename: created.original_filename || file.name,
          url: created.url || file.name,
        },
      ]);
    } catch {}
  };

  const handleAddLink = async (url) => {
    try {
      const created = await onAddLink(url, "", { temporary: true });
      if (!created?.id) return;
      setSources((prev) => [
        ...prev,
        {
          id: created.id,
          original_filename: created.original_filename || url,
          url: created.url || url,
        },
      ]);
    } catch {}
  };

  const handleDeleteSource = (id) => {
    setSources((prev) => prev.filter((s) => s.id !== id));
    onDeleteSource(id);
  };

  const confirm = async (messageId, proposalId) => {
    const plan = messages.find((message) => message.id === messageId)?.proposals || [];
    const pending = plan.filter(
      (proposal) =>
        (proposal.status || "pending") === "pending" &&
        proposal.action !== "ask" &&
        proposal.action !== "navigate",
    );
    if (pending.length === 0) return;

    let freshState = null;
    const confirmedIds = [];
    setSending(true);
    try {
      // Create the goal first, then confirm its dependent milestones and
      // commitments so the resolver can attach them to the new goal.
      const ordered = [...pending].sort((a, b) =>
        Number(b.action === "create_goal") - Number(a.action === "create_goal"),
      );
      for (const proposal of ordered) {
        setBusyProposal(proposal.id);
        const resp = await api.confirm(messageId, proposal.id);
        freshState = resp?.state || freshState;
        confirmedIds.push(proposal.id);
        setMessages((prev) =>
          prev.map((message) =>
            message.id !== messageId
              ? message
              : {
                  ...message,
                  proposals: message.proposals.map((item) =>
                    item.id === proposal.id ? { ...item, status: "confirmed" } : item,
                  ),
                },
          ),
        );
      }

      const createdProposal = plan.find((proposal) => proposal.action === "create_goal");
      const createdGoalTitle = createdProposal?.args?.title || "your new goal";
      const createdGoalId = freshState?.goals?.find(
        (goal) => goal.title === createdGoalTitle && goal.status === "active",
      )?.id;
      setMessages((prev) => [
        ...prev,
        {
          id: `success_${Date.now()}`,
          role: "success",
          content: `Created "${createdGoalTitle}" and confirmed ${confirmedIds.length} plan item${confirmedIds.length === 1 ? "" : "s"}`,
          goalId: createdGoalId,
          goalTitle: createdGoalTitle,
          createdAt: new Date().toISOString(),
        },
      ]);
      onGoalConfirmed?.(proposalId);
      setTimeout(() => onClose?.(), 700);
    } catch (e) {
      if (confirmedIds.length > 0) onGoalConfirmed?.(proposalId);
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't confirm the full plan. Retry to finish it.");
    } finally {
      setSending(false);
      setBusyProposal(null);
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

  const onOpenRefine = (proposal) => {
    setRefiningProposal(proposal);
  };
  const onOpenReject = (proposal) => {
    setRejectingProposal(proposal);
  };

  const submitRefine = (thought) => {
    if (!refiningProposal) return;
    // Local-only: store the note and CLEAR any rejection (a card is either
    // refined or rejected, never both). Applied in a batch from the pinned
    // "Refine goals" button.
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

  const submitReject = async (reason) => {
    if (!rejectingProposal) return;
    const messageId = findProposalMessageId(rejectingProposal);
    if (!messageId) {
      throw new Error("Couldn't find the original proposal to reject.");
    }
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
  //   - else → button label = "Recreate goals & commitments" (re-ask the
  //     coach to bundle milestones and commitments into the next proposal)
  //
  // The button is a thin override on top of ToolConfirmationPrompt: the
  // existing Confirm / Refine / Reject buttons inside the proposal card
  // stay so a user with a mouse can still act inline.
  const pinnedAction = (() => {
    if (input.trim().length > 0) return null;
    // Find the latest assistant message with proposals.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "assistant" || m.streaming) continue;
      const proposals = m.proposals || [];
      if (proposals.length === 0) continue;

      // Priority 1 — if the user has saved any refinements OR rejections,
      // the button becomes the batch "Apply changes" action. A card is
      // refined XOR rejected, so count both (founder feedback: rejecting
      // alone never changed the pinned footer).
      const refined = proposals.filter((p) => p.refinement);
      const rejectedRefs = proposals.filter((p) => p.status === "rejected");
      const changedCount = refined.length + rejectedRefs.length;
      if (changedCount > 0) {
        return {
          messageId: m.id,
          proposalId: null,
          label: `Apply changes (${changedCount})`,
          variant: "refine",
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
            ? `Confirm${pending.length > 0 ? ` (${pending.length} ${pending.length === 1 ? "change" : "changes"})` : ""}`
            : "Recreate goals & commitments",
          variant: hasMilestones ? "confirm" : "recreate",
        };
      }

      if (pending.length > 0) {
        return {
          messageId: m.id,
          proposalId: null,
          label: `Confirm remaining plan items (${pending.length})`,
          variant: "confirm_all",
        };
      }

      // No pending create_goal — everything was rejected / refined away,
      // or the plan is milestones-only. Offer a redefine from scratch.
      return {
        messageId: m.id,
        proposalId: null,
        label: "Redefine goals & commitments",
        variant: "redefine",
      };
    }
    return null;
  })();

  const onPinnedAction = () => {
    if (!pinnedAction) return;

    if (pinnedAction.variant === "refine") {
      // Batch: send every saved refinement + rejection to the LLM once.
      const ps = pinnedAction.proposals || [];
      const labelFor = (p) => p.args?.title || p.args?.text || p.title || p.action || "item";
      const refined = ps.filter((p) => p.refinement);
      const rejected = ps.filter((p) => p.status === "rejected");
      const lines = [];
      if (refined.length) {
        lines.push("Refine these (keep everything else):");
        refined.forEach((p) => lines.push(`- ${labelFor(p)}: ${p.refinement}`));
      }
      if (rejected.length) {
        lines.push("Drop or rework these:");
        rejected.forEach((p) => lines.push(`- ${labelFor(p)}${p.rejection ? `: ${p.rejection}` : ""}`));
      }
      send(
        `Re-propose the plan applying ALL of these notes at once. Return the full goal + milestones + commitments again with the changes applied.\n\n${lines.join("\n")}`,
      );
      return;
    }

    if (pinnedAction.variant === "confirm" || pinnedAction.variant === "confirm_all") {
      confirm(pinnedAction.messageId, pinnedAction.proposalId);
      return;
    }
    if (pinnedAction.variant === "redefine") {
      send(
        "Scrap that plan. Re-propose this goal from scratch — one goal, then 3-4 milestones with target dates, then 2-3 weekly commitments (smallest first step first). Same category, same voice.",
      );
      return;
    }
    // Recreate — re-ask the coach to bundle milestones + commitments.
    send(
      "Your last proposal was a goal with no milestones and no commitments. Re-propose the SAME goal but bundle at least 3 milestones (with target dates) and at least 2 weekly commitments (smallest first step + smallest second step). Same voice, same why, same first action.",
    );
  };

  const activeCat = CATEGORIES.find((c) => c.id === activeCategory);

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={Sparkles}
      title={step === "chat" && activeCat ? `${activeCat.label} goal` : "Add a new goal"}
      subtitle={
        step === "tiles"
          ? "Pick what area this goal is in. You can refine the details once we start talking."
          : activeCat
          ? `Tell the coach about your ${activeCat.label.toLowerCase()} goal — or just hit send and they'll propose something.`
          : "Describe what you're working on."
      }
      maxWidth="max-w-3xl"
      testId="add-goal-dialog"
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
      {step === "tiles" ? (
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

          {/* Isolated ChatConsole — own messages/sending/input, NOT
              shared with the left-hand console. "Same component,
              different context" as the user requested.
              showSources={false} hides the attach / link buttons —
              sources don't apply to a goal-add chat, and the no-op
              stubs were surfacing as a confusing dead UI. */}
          <div className="flex-1 min-h-0 -mx-5 sm:mx-0 border-t border-[var(--border)] flex flex-col">
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
              showSources={true}
              focusOnMount={true}
              // AddGoalDialog uses its own pinned Confirm button; suppress
              // the per-item Confirm so there aren't two confirm paths.
              showConfirm={false}
            />
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
                <button
                  data-testid="pinned-action-button"
                  onClick={onPinnedAction}
                  disabled={sending || (pinnedAction.proposalId != null && busyProposal === pinnedAction.proposalId)}
                  className={`w-full h-12 rounded-full inline-flex items-center justify-center gap-2 text-[15px] font-semibold transition-opacity disabled:opacity-40 hover:opacity-90 active:scale-[0.99] ${
                    pinnedAction.variant === "confirm" || pinnedAction.variant === "confirm_all" || pinnedAction.variant === "refine"
                      ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                      : "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                  }`}
                >
                  {pinnedAction.variant === "confirm" || pinnedAction.variant === "confirm_all" ? (
                    <Check className="w-4 h-4" aria-hidden="true" />
                  ) : pinnedAction.variant === "refine" ? (
                    <Pencil className="w-4 h-4" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="w-4 h-4" aria-hidden="true" />
                  )}
                  {pinnedAction.label}
                </button>
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
