import { useEffect, useRef, useState, useCallback } from "react";
import { MessageSquare, Sparkles, Pencil, RefreshCw } from "lucide-react";
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

/**
 * FocusedTaskChatDialog — isolated chat for goal-level actions
 * (edit, pause, drop, add_step) and source-boundary replans.
 *
 * Replicates the AddGoalDialog pattern: own useState for the entire
 * chat, no shared `messages[]` with the global ChatModal, history
 * starts empty and resets on close.
 *
 * Differs from AddGoalDialog:
 *   - No 2-step tile→chat flow — we already have context from the
 *     action that opened us, so we land directly in the chat.
 *   - Pre-fills the input with `prefillMessage` so the user doesn't
 *     have to paste manually.
 *
 * The dialog self-closes after a successful proposal confirm
 * (`onClose` is invoked from the proposal confirm handler when the
 * message type goes `confirmed` and no other dialog is open).
 */
export default function FocusedTaskChatDialog({
  open,
  onClose,
  title = "Chat with your coach",
  subtitle = "Focus on this task. The chat below starts fresh and resets when you close it.",
  // When set, the empty body shows this one plain line instead of the
  // "About this / scoped" block — used by goal actions (drop/pause/edit)
  // so the follow-up reads as a simple chat, not a scoped-task screen.
  emptyPrompt = "",
  // When true, the prefill is SENT on open (goal actions) so the coach
  // replies immediately instead of leaving it in the composer.
  autoSend = false,
  // Called ({ goalTitle, freed }) after a drop frees weekly capacity and
  // other goals remain — the parent opens a `review_progress` chat. Optional.
  onRequestReplan = null,
  prefillMessage = "",
  icon: Icon = MessageSquare,
  user,
  isGuest,
  autoAnswer = true,
  grillMe = false,
  setAutoAnswer,
  setGrillMe,
  onStateChange,
  onAction,
  onNavigate,
  onUploadFile,
  onAddLink,
  onOpenSignIn,
  // Iteration 5 — scoped chat context. Caller passes these so the
  // server can mint a per-entity conversation
  // (`conv_<kind>_<refId>`) and the post-confirm close can fire.
  scope = null,
  refId = null,
  kind = null,
  helperText = "",
}) {
  // Chat-internal state — fully isolated.
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [busyProposal, setBusyProposal] = useState(null);
  const [pendingClarifications, setPendingClarifications] = useState(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // Set after a successful drop that freed capacity — renders the opt-in
  // "re-plan your remaining goals?" banner.
  const [dropReplan, setDropReplan] = useState(null);
  // Iteration 9 — refine / reject modal state. Focused-task chats
  // already start empty (no bucket bleed), so these are independent.
  const [refiningProposal, setRefiningProposal] = useState(null);
  const [rejectingProposal, setRejectingProposal] = useState(null);
  // Iteration 9 — back button closes this dialog.
  useDialogBack(open, onClose, `focused-task:${refId || ""}`);
  // Session attachments — real server sources added in THIS chat, so the
  // chip X can delete them server-side (same pattern as ChatModal).
  const [sources, setSources] = useState([]);
  const streamIdRef = useRef(0);
  // Always-current view of messages, so confirmProposal can read the
  // proposal (and its drop impact) without a stale closure.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // Iteration 10 — renegotiation dialog state.
  const [renegotiation, setRenegotiation] = useState(null);
  const [busyChoice, setBusyChoice] = useState(null);
  const previousAutoAnswerRef = useRef(autoAnswer);
  const autoResumePendingRef = useRef(false);
  // Operation-scoped context (spec §10) — current conversation bucket,
  // seeded from the parent's `refId` prop and swapped on confirm /
  // defensive redirect. For focused-task chats the parent usually
  // passes an entity id; when it doesn't, we mint per open.
  const refIdRef = useRef(refId ?? null);

  // Reset everything on open / close transitions so a re-open always
  // starts fresh (the goal of the user's "clear state per focused
  // task" complaint).
  useEffect(() => {
    if (open) {
      setMessages([]);
      setInput("");
      setSending(false);
      setBusyProposal(null);
      setPendingClarifications(null);
      setHistoryLoaded(false);
      setDropReplan(null);
      setSources([]);
      setRenegotiation(null);
      setBusyChoice(null);
      clearRenegotiation();
      // Fresh bucket per open — scoped chats get the entity id the
      // parent passed; unscoped ones mint a focused-task bucket so the
      // server never falls back to the long-lived general history.
      refIdRef.current =
        refId || `task_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(36).slice(2, 8)}`;
    }
  }, [open, refId]);

  /**
   * Iteration 10 — render one /chat/plan result into the streaming bubble.
   * Same contract as ChatModal.applyPlan.
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
        finalize({
          id: result.message_id,
          content: result.prose || "No changes needed.",
        });
      }
    },
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
      if (!open || !user) return;
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
      try {
        // Iteration 10 — planned kinds try the typed pipeline first.
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
            // Same refId for every turn in this bucket (spec §10.3).
            refId: refIdRef.current,
            kind,
            title,
            helperText,
            // Current-conversation attachments — see ChatModal.
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
            // Structured impact block (spec §10.6).
            setMessages((prev) =>
              prev.map((m) =>
                m.id === (finalId || streamId) ? { ...m, impact: data.impact } : m,
              ),
            );
          } else if (data.type === "done") {
            // Defensive redirect (spec §10.2) — closed bucket minted fresh.
            if (data.redirected && data.ref_id) refIdRef.current = data.ref_id;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === (finalId || streamId)
                  ? { ...m, id: data.message_id, streaming: false }
                  : m,
              ),
            );
          } else if (data.type === "error") {
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
              try { handle(JSON.parse(raw.slice(6))); } catch { /* ignore */ }
            }
          }
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        );
      } finally {
        setSending(false);
        setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
      }
    },
    [open, user, autoAnswer, grillMe, scope, kind, title, helperText, sources, tryPlan],
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

  // Iteration 10 — renegotiation choice → pipeline round 2.
  const onRenegotiationChoice = useCallback(
    (choice) => {
      setBusyChoice(choice);
      setRenegotiation(null);
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

  const confirmProposal = useCallback(
    async (messageId, proposalId) => {
      setBusyProposal(proposalId);
      // Read from the ref (not the closure) so the drop impact is current.
      const pendingProposal = messagesRef.current
        .find((m) => m.id === messageId)
        ?.proposals?.find((p) => p.id === proposalId);
      try {
        const { result, state, ref_id } = await api.confirm(messageId, proposalId);
        // Spec §10.4 — swap to the server-pre-minted next bucket.
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
            }[proposal?.action] || "Confirmed";
          const content = title ? `${verb} "${title}"` : result || "Change applied";
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
            // Success divider inline in the stream (spec §10.5).
            {
              id: `success_${Date.now()}`,
              role: "success",
              content,
              goalTitle: title,
              createdAt: new Date().toISOString(),
            },
          ];
        });
        // Bubble state up so the dashboard re-renders
        onStateChange?.(state);
        // Drop freed capacity and other goals remain → offer a re-plan
        // (opt-in; the user decides).
        const impact = pendingProposal?.args?.impact;
        if (
          pendingProposal?.action === "drop_goal" &&
          impact &&
          typeof impact.freed_weekly_hours === "number" &&
          impact.freed_weekly_hours > 0 &&
          (impact.other_active_goals || 0) > 0
        ) {
          setDropReplan({
            goalTitle:
              pendingProposal.args?.goal_title ||
              pendingProposal.args?.title ||
              "the goal",
            freed: impact.freed_weekly_hours,
          });
        }
      } catch (e) {
        toast.error("Couldn't confirm that proposal. Try again.");
      } finally {
        setBusyProposal(null);
      }
    },
    [onStateChange],
  );

  // Drop flow (revised): a drop proposal is NO LONGER auto-applied. The
  // card now carries a deterministic impact preview ("what this changes" +
  // freed hours), so the user explicitly confirms the destructive cascade
  // from the card. After a successful drop the banner below offers the
  // opt-in re-plan.

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

  // Iteration 9 — refine / reject open modals instead of chat round-trip.
  const refineProposal = useCallback(() => {}, []);

  const findProposalMessageId = useCallback((proposal) => {
    for (const m of messages) {
      if ((m.proposals || []).some((p) => p.id === proposal.id)) return m.id;
    }
    return null;
  }, [messages]);

  const onOpenRefine = useCallback((proposal) => setRefiningProposal(proposal), []);
  const onOpenReject = useCallback((proposal) => setRejectingProposal(proposal), []);

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

  // Count BOTH refinements and rejections on the latest plan — a card is
  // refined XOR rejected, so either should surface the batch action.
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

  const uploadFile = useCallback(
    async (file) => {
      try {
        const created = await api.uploadSource(file, "", { temporary: true });
        const fresh = await api.state();
        onStateChange?.(fresh);
        if (created?.id) setSources((prev) => [...prev, created]);
        return created || null;
      } catch {
        /* offline fine */
        return null;
      }
    },
    [onStateChange],
  );

  const addLink = useCallback(
    async (url, goalId = "", options = {}) => {
      if (!url) return null;
      try {
        const created = await api.addLink({
          url,
          goal_id: goalId || "",
          temporary: true,
          ...(typeof options.text === "string" && options.text.trim() ? { text: options.text } : {}),
        });
        const fresh = await api.state();
        onStateChange?.(fresh);
        if (created?.id) setSources((prev) => [...prev, created]);
        return created || null;
      } catch {
        /* offline fine */
        return null;
      }
    },
    [onStateChange],
  );

  // Chip X — deletes the attachment server-side ("keep data clean"),
  // then drops it from the local chip list. Also offered to the parent.
  const deleteSource = useCallback(
    async (id) => {
      if (!id) return;
      setSources((prev) => prev.filter((s) => s.id !== id));
      try {
        await api.deleteSource(id);
        const fresh = await api.state();
        onStateChange?.(fresh);
      } catch {
        toast.error("Couldn't remove that attachment. Try again.");
      }
    },
    [onStateChange],
  );

  // Auto-send mode (goal actions) — hand the prefilled reason to the coach
  // the moment the dialog opens so it replies immediately and the user just
  // continues the conversation. Guarded so it fires once per open.
  const autoSentRef = useRef(false);
  useEffect(() => {
    if (!open) {
      autoSentRef.current = false;
      return;
    }
    if (!autoSend || autoSentRef.current) return;
    if (!prefillMessage || !user) return;
    if (messages.length > 0 || sending) return;
    autoSentRef.current = true;
    send(prefillMessage);
  }, [open, autoSend, prefillMessage, user, messages.length, sending, send]);

  // Otherwise: prefill the composer so the user can review/edit before send.
  useEffect(() => {
    if (autoSend) return;
    if (open && prefillMessage && !historyLoaded && input === "" && messages.length === 0) {
      setInput(prefillMessage);
    }
  }, [autoSend, open, prefillMessage, historyLoaded, input, messages.length]);

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={Icon}
      title={title}
      subtitle={subtitle}
      maxWidth="max-w-3xl"
      testId="focused-task-chat-modal"
    >
      <div className="-mx-5 -mb-4 h-[68vh] min-h-[min(440px,60dvh)] max-h-[760px] border-t border-[var(--border)]">
        <ChatConsole
          messages={messages}
          onSend={send}
          sending={sending}
          input={input}
          setInput={setInput}
          onConfirm={confirmProposal}
          onReject={(messageId, proposalId) => {
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
          onClearChat={() => setMessages([])}
          focusOnMount={open}
          // Focused-task dialogs always have a specific subject —
          // mirror AddGoalDialog's per-category subtitle so the empty
          // body says what this chat is for, not the generic "tell
          // me everything" onboarding. Goal actions pass `emptyPrompt`
          // to keep it a plain chat (no scoping boilerplate).
          scopeLabel={emptyPrompt ? "" : (title && title !== "Chat with your coach" ? title : "")}
          scopeIntent={emptyPrompt ? "" : (helperText || (subtitle && subtitle !== "Focus on this task. The chat below starts fresh and resets when you close it." ? subtitle : "Talk to the coach about this —"))}
          emptyPrompt={emptyPrompt}
          pendingClarifications={pendingClarifications}
          onAnswerClarification={onAnswerClarification}
          onDismissClarifications={onDismissClarifications}
        />
      </div>
      {dropReplan && (
        <div
          data-testid="drop-replan-banner"
          className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] p-3"
        >
          <RefreshCw className="w-4 h-4 text-[var(--accent)] shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-[200px] text-[13px] leading-relaxed text-[var(--text-primary)]">
            You now have <span className="font-semibold">{dropReplan.freed}h/week</span> free
            from dropping &ldquo;{dropReplan.goalTitle}&rdquo;. Re-plan your remaining goals?
          </span>
          <div className="flex items-center gap-2">
            <button
              data-testid="drop-replan-button"
              onClick={() => onRequestReplan?.(dropReplan)}
              className="min-h-9 inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--bg-primary)] hover:opacity-90"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Re-plan
            </button>
            <button
              data-testid="drop-replan-dismiss"
              onClick={() => setDropReplan(null)}
              className="min-h-9 rounded-full px-3 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              Not now
            </button>
          </div>
        </div>
      )}
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
            data-testid="focused-task-chat-signin"
            onClick={onOpenSignIn}
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
