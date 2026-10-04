import { useState, useRef, useCallback, useEffect } from "react";
import { Sparkles, MessageSquare, Pencil } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import ChatConsole from "./ChatConsole";
import RefineModal from "./RefineModal";
import RejectModal from "./RejectModal";
import RenegotiationDialog from "./RenegotiationDialog";
import {
  usePlanSend,
  renegotiationChoiceLabel,
  clearRenegotiation,
} from "../hooks/use-plan-send";
import { useDialogBack } from "../hooks/useDialogBack";
import { toast } from "sonner";
import { api, API } from "../lib/api";
import { readDraftBucket, writeDraftBucket } from "../hooks/useDraftPersistence";

/**
 * ChatModal — the chat is no longer a persistent panel on the left of
 * the Coach route. The dashboard fills the screen by default, and the
 * chat opens in this centered modal whenever the user clicks the
 * "Chat with coach" button in the header (or the floating bottom-right
 * action).
 *
 * The chat is its own state owner — conversation history, the input
 * field, in-flight proposals, voice input all live here. Reopening the
 * modal shows the prior conversation; the messages survive across
 * mounts because we only `useEffect`-fetch history on user change.
 *
 * Proposal confirm/reject flows communicate up to the parent via
 * `onStateChange` (which the parent uses to re-pull `/api/state`) so
 * the dashboard always reflects what the coach just wrote.
 */
export default function ChatModal({
  open,
  onClose,
  user,
  setUser,
  autoAnswer,
  setAutoAnswer,
  grillMe,
  setGrillMe,
  onStateChange,
  onAction,
  onNavigate,
  onUploadFile,
  onAddLink,
  onOpenSignIn,
  isGuest,
  prefillMessage = "",
  // Iteration 5 — scoped chat context. When the modal opens from a
  // Timeline tile / Today timetable item / milestone, the caller passes
  // these so the title bar can read "About: <subject>" and the server
  // can mint a per-entity conversation (`conv_<kind>_<refId>`).
  scope = null,
  refId = null,
  kind = null,
  title = "",
  helperText = "",
}) {
  // Chat-internal state — fully isolated from the dashboard.
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [busyProposal, setBusyProposal] = useState(null);
  const [pendingClarifications, setPendingClarifications] = useState(null);
  const [showDraftPrompt, setShowDraftPrompt] = useState(false);
  // True while this open's history is being fetched — drives the shimmer.
  const [loadingHistory, setLoadingHistory] = useState(false);
  // Iteration 9 — refine / reject modal state. The modal owns the
  // input; the dialog owns the lifecycle and the proposal lookup.
  const [refiningProposal, setRefiningProposal] = useState(null);
  const [rejectingProposal, setRejectingProposal] = useState(null);
  // Iteration 9 — browser/system back button closes this dialog
  // instead of exiting the app.
  useDialogBack(open, onClose, "chat-modal");
  // Sources attached during THIS chat session. Kept locally so the chips
  // render above the composer and an X on a chip can delete the row it
  // stands for — previously the parent passed `sources={[]}` and a no-op
  // delete, so a dismissed attachment quietly stayed on the server.
  const [sources, setSources] = useState([]);
  const streamIdRef = useRef(0);
  // Iteration 10 — renegotiation dialog state (planner headroom).
  const [renegotiation, setRenegotiation] = useState(null);
  const [busyChoice, setBusyChoice] = useState(null);
  // Operation-scoped context (spec §10) — the current conversation
  // bucket. Seeded from the `refId` prop the parent passes (entity id
  // for scoped opens, null for the general chat) and swapped only on
  // confirm (server pre-mints the next bucket) or on a defensive
  // redirect in the `done` SSE event.
  const refIdRef = useRef(refId ?? null);
  const previousAutoAnswerRef = useRef(autoAnswer);
  const autoResumePendingRef = useRef(false);
  const reusedDraftRef = useRef(false);

  // Re-seed the bucket whenever the modal reopens or the parent swaps
  // the scoped context. Falls back to a kind-appropriate mint when a
  // kind was given without an entity id (spec §10.1).
  useEffect(() => {
    if (!open) {
      // Leaving the chat discards any parked renegotiation so the next
      // open can't silently attach the last goal's context.
      clearRenegotiation();
      setRenegotiation(null);
      setBusyChoice(null);
    }
    if (!open) return;
    // Entity-scoped opens always target the passed bucket — never reuse a draft.
    if (refId) {
      refIdRef.current = refId;
      reusedDraftRef.current = false;
      return;
    }
    const draftKey = kind || "general";
    const isMintedKind =
      kind === "add_goal" ||
      kind === "plan_day" ||
      kind === "review_progress" ||
      Boolean(scope) ||
      Boolean(title) ||
      Boolean(kind && kind !== "general");
    // Planned / action chats are client-minted. Reuse the draft minted earlier
    // this app session so an accidental Escape or back-nav does not orphan it.
    if (isMintedKind) {
      const saved = readDraftBucket(draftKey);
      if (saved) {
        refIdRef.current = saved;
        reusedDraftRef.current = true;
        return;
      }
    }
    if (kind === "add_goal" || isMintedKind) {
      refIdRef.current =
        kind === "add_goal"
          ? `new_goal_${crypto.randomUUID()}`
          : `action_${crypto.randomUUID()}`;
    } else {
      // General / unscoped chat — server falls back to
      // conv_general_<userId>; no client-side bucket.
      refIdRef.current = null;
      reusedDraftRef.current = false;
      return;
    }
    reusedDraftRef.current = false;
    writeDraftBucket(draftKey, refIdRef.current);
  }, [open, refId, kind, scope, title]);

  // Seed the input whenever the modal opens or the opener swaps the
  // prefill. Two jobs:
  //   - opener passed text → drop it in (Today's free-text box, etc.);
  //   - opener passed ""   → CLEAR whatever was left from the last
  //     open. The old early-return on falsy prefill is what left
  //     "For \"Investor email batch 2\"…" sitting in a chat that had
  //     since been reopened about a different commitment.
  useEffect(() => {
    if (!open) return;
    setInput(prefillMessage || "");
  }, [open, prefillMessage]);

  // Reset + (re)load on EVERY open. `open` is the trigger; the scoped
  // props are read from the current render — the parent sets them in the
  // same render it flips `open` to true, so a scoped open never inherits
  // the previous chat's transcript. This modal is a SINGLE instance
  // shared by the global chat, Today's box, Timeline tile chats, and
  // TodayTimetable item chats — without this reset they all leaked into
  // each other (the old `historyLoaded` gate skipped the reset after the
  // first open).
  useEffect(() => {
    if (!open || !user) return undefined;
    let cancelled = false;
    // Fresh per-open state.
    setMessages([]);
    setLoadingHistory(true);
    setSending(false);
    setBusyProposal(null);
    setPendingClarifications(null);
    setSources([]);
    setRefiningProposal(null);
    setRejectingProposal(null);
    setRenegotiation(null);
    setBusyChoice(null);
    clearRenegotiation();
    // Fetch ONLY this chat's bucket. `refIdRef.current` was just seeded by
    // the effect above (declared earlier → runs first), so a scoped chat
    // loads its own transcript and the global chat loads only the general
    // bucket — no cross-chat leakage.
    api
      .history({ refId: refIdRef.current, kind, scope })
      .then((m) => {
        if (cancelled) return;
        const list = m || [];
        setMessages(list);
        // Reopened a draft that still has content → offer Continue / Start new.
        setShowDraftPrompt(reusedDraftRef.current && list.length > 0);
      })
      .catch(() => {
        toast.error("Couldn't load chat history. Starting fresh — new messages still send.");
      })
      .finally(() => { if (!cancelled) setLoadingHistory(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.user_id, refId, kind, scope]);

  /**
   * Iteration 10 — render one /chat/plan result into the streaming bubble
   * opened by `send`. The planner responds as a single JSON payload; we
   * write it into the bubble the send opened, then finalize.
   */
  const applyPlan = useCallback(
    (result, { streamId }) => {
      const finalize = (patch) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === streamId ? { ...m, streaming: false, ...patch } : m)),
        );

      if (result.status === "ok") {
        finalize({
          id: result.message_id,
          content:
            (result.prose || "") +
            (result.headroom?.message ? `\n\n(${result.headroom.message})` : ""),
          proposals: result.proposals || [],
        });
        // Proposals are persisted server-side; refresh the dashboard so it
        // reflects the new rows once the user confirms.
        api.state().then((s) => onStateChange?.(s)).catch(() => {});
      } else if (result.status === "clarify") {
        finalize({
          id: result.message_id,
          content: result.prose || "A couple of details first:",
        });
        setPendingClarifications({
          messageId: result.message_id,
          prompt: result.prose || "",
          questions: result.questions || [],
        });
      } else if (result.status === "renegotiate") {
        finalize({ id: result.message_id, content: result.prose || "" });
        setRenegotiation({
          headroom: result.headroom,
          options: result.options || [],
        });
      } else {
        // no_change / early
        finalize({
          id: result.message_id,
          content: result.prose || "No changes needed.",
        });
      }
    },
    // onStateChange is stable (Coach.js passes a setState wrapper); api.state
    // is module-level. setMessages/setPendingClarifications/setRenegotiation
    // are stable React setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Must be declared BEFORE `send` — send references tryPlan in its body
  // and deps (TDZ error otherwise).
  const { tryPlan } = usePlanSend({
    kind,
    scope,
    refIdRef,
    title,
    helperText,
    autoAnswer,
    grillMe,
    sources,
    setMessages,
    applyPlan,
  });

  const send = useCallback(
    async (text) => {
      setSending(true);
      setInput("");
      const localUserId = `local_${Date.now()}`;
      const streamId = `stream_${++streamIdRef.current}`;
      setMessages((prev) => [
        ...prev,
        { id: localUserId, role: "user", content: text, proposals: [] },
        {
          id: streamId,
          role: "assistant",
          content: "",
          proposals: [],
          streaming: true,
        },
      ]);
      // Iteration 10 — the five planned kinds try the typed pipeline first.
      // falls back to the SSE path below when the planner is disabled,
      // errors, or isn't applicable.
      try {
      const handled = await tryPlan(text, streamId);
        if (handled) return;
        const resp = await fetch(`${API}/chat/stream`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            auto_answer: autoAnswer,
            clarify: grillMe,
            scope,
            // Same refId for every turn in this bucket; swapped by
            // confirm / done-redirect (spec §10.3).
            refId: refIdRef.current,
            kind,
            title,
            helperText,
            // Current-conversation attachments — the server reads their
            // stored text excerpts and injects them into the prompt.
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
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamId
                  ? { ...m, content: m.content + data.content }
                  : m,
              ),
            );
          } else if (data.type === "tools") {
            finalId = data.message_id;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamId
                  ? { ...m, id: data.message_id, proposals: data.proposals }
                  : m,
              ),
            );
          } else if (data.type === "needs_clarification") {
            finalId = data.message_id;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamId
                  ? { ...m, id: data.message_id, streaming: false }
                  : m,
              ),
            );
            setPendingClarifications({
              messageId: data.message_id,
              prompt: data.prompt,
              questions: data.questions || [],
            });
          } else if (data.type === "impact") {
            // Structured impact block (spec §10.6) — attach to the
            // assistant message that produced it.
            setMessages((prev) =>
              prev.map((m) =>
                m.id === (finalId || streamId) ? { ...m, impact: data.impact } : m,
              ),
            );
          } else if (data.type === "done") {
            // Defensive redirect (spec §10.2) — server detected we
            // sent to a closed bucket and minted a fresh one.
            if (data.redirected && data.ref_id) refIdRef.current = data.ref_id;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === (finalId || streamId)
                  ? { ...m, id: data.message_id, streaming: false }
                  : m,
              ),
            );
          } else if (data.type === "error") {
            toast.error(data.content || "The coach hit an error. Try again.");
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamId
                  ? {
                      ...m,
                      streaming: false,
                      content: m.content || "(no response)",
                    }
                  : m,
              ),
            );
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
            if (raw.startsWith("data: ")) {
              try {
                handle(JSON.parse(raw.slice(6)));
              } catch {
                /* ignore malformed event */
              }
            }
          }
        }
      } catch {
        toast.error("Connection dropped. Try sending that again.");
      } finally {
        setSending(false);
        setMessages((prev) =>
          prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        );
      }
    },
    [autoAnswer, grillMe, scope, kind, title, helperText, sources, tryPlan],
  );

  useEffect(() => {
    const switchedToAuto = autoAnswer && !previousAutoAnswerRef.current;
    previousAutoAnswerRef.current = autoAnswer;
    if (switchedToAuto && (pendingClarifications || sending)) {
      autoResumePendingRef.current = true;
    }
    if (autoAnswer && autoResumePendingRef.current && pendingClarifications && !sending) {
      autoResumePendingRef.current = false;
      setPendingClarifications(null);
      send('Proceed with reasonable assumptions for anything unanswered and make the plan now.');
    } else if (!sending && !pendingClarifications) {
      autoResumePendingRef.current = false;
    }
  }, [autoAnswer, pendingClarifications, sending, send]);

  const confirmProposal = useCallback(
    async (messageId, proposalId) => {
      setBusyProposal(proposalId);
      try {
        const { result, state, ref_id } = await api.confirm(
          messageId,
          proposalId,
        );
        // Spec §10.4 — server closed this bucket and (for add_goal)
        // pre-minted the next. Swap so the next send lands fresh.
        if (ref_id) refIdRef.current = ref_id;
        setMessages((prev) => {
          const proposal = prev
            .find((m) => m.id === messageId)
            ?.proposals?.find((p) => p.id === proposalId);
          const title =
            proposal?.args?.title ||
            proposal?.args?.label ||
            proposal?.args?.goal_title ||
            proposal?.args?.new_title ||
            proposal?.title;
          const verb =
            {
              create_goal: "Created",
              drop_goal: "Dropped",
              pause_goal: "Paused",
              add_milestone: "Added milestone",
              add_block: "Scheduled",
              add_commitment: "Added commitment",
              complete_commitment: "Completed",
            }[proposal?.action] || "Confirmed";
          const content = title ? `${verb} "${title}"` : result || "Change applied";
          const goalId =
            proposal?.action === "create_goal" && title
              ? state?.goals?.find(
                  (g) => g.title === title && g.status === "active",
                )?.id
              : undefined;
          return [
            ...prev.map((m) =>
              m.id === messageId
                ? {
                    ...m,
                    proposals: m.proposals.map((p) =>
                      p.id === proposalId ? { ...p, status: "confirmed" } : p,
                    ),
                  }
                : m,
            ),
            // Success divider inline in the stream (spec §10.5) — the
            // visible messages are NOT cleared on confirm.
            {
              id: `success_${Date.now()}`,
              role: "success",
              content,
              goalId,
              goalTitle: title,
              createdAt: new Date().toISOString(),
            },
          ];
        });
        toast.success(result);
        onStateChange?.(state);
      } catch (e) {
        toast.error(typeof e?.message === 'string' ? e.message : "Couldn't apply the change. Try again.");
      } finally {
        setBusyProposal(null);
      }
    },
    [onStateChange],
  );

  const rejectProposal = useCallback((messageId, proposalId, reason) => {
    // Optimistic — flip the UI immediately, persist in the background.
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              proposals: m.proposals.map((p) =>
                p.id === proposalId ? { ...p, status: "rejected" } : p,
              ),
            }
          : m,
      ),
    );
    api.reject(messageId, proposalId, reason).catch(() => {
      toast.error("Couldn't record that rejection — check your connection.");
    });
  }, []);

  // Iteration 9 — refine / reject open parent-owned modals instead of
  // round-tripping through the chat stream. `refineProposal` is kept
  // as a no-op shim so any stale callers don't crash; new code uses
  // `onOpenRefine` / `onOpenReject`.
  const refineProposal = useCallback(() => {}, []);

  const findProposalMessageId = useCallback((proposal) => {
    for (const m of messages) {
      if ((m.proposals || []).some((p) => p.id === proposal.id)) return m.id;
    }
    return null;
  }, [messages]);

  const onOpenRefine = useCallback((proposal) => {
    setRefiningProposal(proposal);
  }, []);

  const onOpenReject = useCallback((proposal) => {
    setRejectingProposal(proposal);
  }, []);

  const submitRefine = useCallback((thought) => {
    if (!refiningProposal) return;
    const id = refiningProposal.id;
    setMessages((prev) =>
      prev.map((m) => ({
        ...m,
        proposals: (m.proposals || []).map((p) =>
          p.id === id ? { ...p, refinement: thought, rejection: "", status: "pending" } : p,
        ),
      })),
    );
  }, [refiningProposal]);

  const submitReject = useCallback((reason) => {
    if (!rejectingProposal) return;
    const id = rejectingProposal.id;
    setMessages((prev) =>
      prev.map((m) => ({
        ...m,
        proposals: (m.proposals || []).map((p) =>
          p.id === id ? { ...p, status: "rejected", rejection: reason || "", refinement: "" } : p,
        ),
      })),
    );
  }, [rejectingProposal]);

  const clearRefine = useCallback(() => {
    if (!refiningProposal) return;
    const id = refiningProposal.id;
    setMessages((prev) =>
      prev.map((m) => ({
        ...m,
        proposals: (m.proposals || []).map((p) => (p.id === id ? { ...p, refinement: "" } : p)),
      })),
    );
  }, [refiningProposal]);

  const clearReject = useCallback(() => {
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
  }, [rejectingProposal]);

  // Batch — send every saved refinement + rejection to the LLM once.
  const applyRefinements = useCallback(() => {
    const refined = [];
    const rejected = [];
    messages.forEach((m) => {
      (m.proposals || []).forEach((p) => {
        const label = p.args?.title || p.args?.text || p.title || p.action || "item";
        if (p.refinement) refined.push(`- ${label}: ${p.refinement}`);
        if (p.status === "rejected") rejected.push(`- ${label}${p.rejection ? `: ${p.rejection}` : ""}`);
      });
    });
    const lines = [];
    if (refined.length) { lines.push("Refine these (keep everything else):"); lines.push(...refined); }
    if (rejected.length) { lines.push("Drop or rework these:"); lines.push(...rejected); }
    send(`Re-propose applying ALL of these notes at once. Return the proposals again with the changes applied.\n\n${lines.join("\n")}`);
  }, [messages, send]);

  // Count BOTH refinements and rejections on the LATEST assistant message
  // with proposals (the active plan), not across the whole transcript —
  // otherwise the batch button lingers after the plan is re-proposed. A
  // card is refined XOR rejected, so either should surface the batch
  // action (founder feedback: rejecting alone left the footer unchanged).
  const latestWithProposals = [...messages].reverse().find(
    (m) => m.role === "assistant" && (m.proposals || []).length > 0,
  );
  const changedCount = (latestWithProposals?.proposals || []).filter(
    (p) => p.refinement || p.status === "rejected",
  ).length;

  const onAnswerClarification = useCallback(
    (text) => {
      setPendingClarifications(null);
      send(text);
    },
    [send],
  );

  const onDismissClarifications = useCallback(
    () => setPendingClarifications(null),
    [],
  );

  // Iteration 10 — user picked one of the four renegotiation options.
  // The parked context (use-plan-send) feeds the pipeline a fresh round;
  // the response renders through the same applyPlan into a NEW bubble.
  const onRenegotiationChoice = useCallback(
    (choice) => {
      setBusyChoice(choice);
      setRenegotiation(null); // close the dialog; progress shows in chat
      const streamId = `stream_${++streamIdRef.current}`;
      setMessages((prev) => [
        ...prev,
        {
          id: streamId,
          role: "assistant",
          content: "",
          proposals: [],
          streaming: true,
        },
      ]);
      tryPlan(renegotiationChoiceLabel(choice), streamId).finally(() =>
        setBusyChoice(null),
      );
    },
    [tryPlan],
  );

  const closeRenegotiation = useCallback(() => {
    setRenegotiation(null);
    clearRenegotiation();
  }, []);

  const uploadFile = useCallback(
    async (file) => {
      toast.message(`Uploading ${file.name}…`);
      try {
        const goalId = scope === "goal" && refId ? refId : "";
        const created = await api.uploadSource(file, goalId, { temporary: !goalId && Boolean(title) });
        if (created?.id) setSources((prev) => [...prev, created]);
        toast.success(`Added ${file.name} as a source`);
        const fresh = await api.state();
        onStateChange?.(fresh);
      } catch (e) {
        toast.error(typeof e?.message === 'string' ? e.message : "Couldn't upload that file. Try again.");
      }
    },
    [onStateChange, refId, scope, title],
  );

  const addLink = useCallback(
    async (url) => {
      if (!url || typeof url !== "string") return;
      try {
        const goalId = scope === "goal" && refId ? refId : "";
        const created = await api.addLink({ url, goal_id: goalId, temporary: !goalId && Boolean(title) });
        if (created?.id) setSources((prev) => [...prev, created]);
        toast.success("Link added as a source");
        const fresh = await api.state();
        onStateChange?.(fresh);
      } catch (e) {
        toast.error(typeof e?.message === 'string' ? e.message : "Couldn't add the link. Try again.");
      }
    },
    [onStateChange, refId, scope, title],
  );

  // Dismissing an attachment chip must actually remove the row — the chip
  // is only a view of a source that was uploaded the moment the paperclip
  // was hit. Drop it from local state AND the server so a file the user
  // never sent doesn't linger in Sources.
  const deleteSource = useCallback(
    async (id) => {
      setSources((prev) => prev.filter((s) => s.id !== id));
      try {
        await api.deleteSource(id);
        const fresh = await api.state();
        onStateChange?.(fresh);
      } catch {
        // Offline / already gone — the chip is dismissed either way.
      }
    },
    [onStateChange],
  );

  const onSignInFromChat = useCallback(() => {
    onOpenSignIn?.();
  }, [onOpenSignIn]);

  // Scoped chat — when a title was passed in (with or without a
  // scope/refId entity anchor), swap the generic header for
  // "About: <subject>" with the helper line below. The earlier
  // requirement that scope AND title both be set meant chat flows
  // like "Build my timeline" — which have a title but no specific
  // entity to anchor on — still rendered the generic header.
  const startNewDraft = useCallback(() => {
    const draftKey = kind || "general";
    const minted =
      kind === "add_goal"
        ? `new_goal_${crypto.randomUUID()}`
        : `action_${crypto.randomUUID()}`;
    refIdRef.current = minted;
    writeDraftBucket(draftKey, minted);
    reusedDraftRef.current = false;
    setMessages([]);
    setPendingClarifications(null);
    setShowDraftPrompt(false);
  }, [kind]);

  const scoped = Boolean(title)
  const headerTitle = scoped ? `About: ${title}` : "Chat with your coach"
  // The general chat is read-only — it answers about your state and routes
  // you to the right screen; it never changes anything itself.
  const headerSubtitle = scoped
    ? (helperText || "Ask anything about this — proposals only land after you confirm.")
    : "Ask about your goals, progress, or what to focus on. To change something, I'll take you to the right screen."

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={MessageSquare}
      title={headerTitle}
      subtitle={headerSubtitle}
      maxWidth="max-w-3xl"
      testId="chat-modal"
    >
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

      <div className="-mx-5 -mb-4 h-[68vh] min-h-[min(440px,60dvh)] max-h-[760px] border-t border-[var(--border)]">
        <ChatConsole
          messages={messages}
          onSend={send}
          sending={sending}
          input={input}
          setInput={setInput}
          onConfirm={confirmProposal}
          onReject={(messageId, proposalId) => {
            // The modal owns the rejection flow; here we just stash
            // the proposal so the modal knows what to label itself.
            const proposal = messages
              .find((m) => m.id === messageId)
              ?.proposals?.find((p) => p.id === proposalId);
            if (proposal) setRejectingProposal(proposal);
          }}
          onOpenRefine={onOpenRefine}
          onOpenReject={onOpenReject}
          onNavigate={onNavigate}
          onAnswerChoice={(text) => send(text)}
          busyProposal={busyProposal}
          autoAnswer={autoAnswer}
          setAutoAnswer={setAutoAnswer}
          grillMe={grillMe}
          setGrillMe={setGrillMe}
          onUploadFile={uploadFile}
          onAddLink={addLink}
          sources={sources}
          onDeleteSource={deleteSource}
          focusOnMount={open}
          scopeLabel={scoped ? title : ""}
          scopeIntent={scoped ? (helperText || "Talk to the coach about this —") : ""}
          // General chat is read-only — no mode switcher there.
          showModeSelect={scoped}
          emptyPrompt={
            scoped
              ? ""
              : "Ask me anything about your goals and progress — or name what you want to change and I'll take you to the right screen."
          }
          loading={loadingHistory}
          onClearChat={async () => {
            try {
              await api.clearHistory();
            } catch {
              /* offline is fine */
            }
            setMessages([]);
          }}
          pendingClarifications={pendingClarifications}
          onAnswerClarification={onAnswerClarification}
          onDismissClarifications={onDismissClarifications}
        />
      </div>
      <RenegotiationDialog
        open={!!renegotiation}
        onClose={closeRenegotiation}
        headroom={renegotiation?.headroom}
        options={renegotiation?.options || []}
        busyOption={busyChoice}
        onChoose={onRenegotiationChoice}
      />
      {isGuest && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-primary)_60%,transparent)] px-3 py-2 text-xs text-[var(--text-secondary)]">
          <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
          <span className="flex-1">
            Sign in to keep this session and unlock every feature.
          </span>
          <button
            type="button"
            data-testid="chat-modal-signin"
            onClick={onSignInFromChat}
            className="min-h-11 font-medium text-[var(--accent)] hover:underline"
          >
            Sign in
          </button>
        </div>
      )}
      {changedCount > 0 && (
        <div className="mt-3">
          <button
            data-testid="pinned-refine-button"
            onClick={applyRefinements}
            disabled={sending}
            className="w-full h-12 rounded-full inline-flex items-center justify-center gap-2 text-[15px] font-semibold bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-40 hover:opacity-90 active:scale-[0.99] transition-opacity"
          >
            <Pencil className="w-4 h-4" aria-hidden="true" /> Apply changes ({changedCount})
          </button>
        </div>
      )}
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
    </CenteredDialog>
  );
}
