import { useCallback, useState } from "react";
import { api } from "../lib/api";

/**
 * usePlanSend — Iteration 10 chat→planner dispatch.
 *
 * Wraps a chat surface's `send` so that, on the five planned intents, a
 * message first tries the typed pipeline (`POST /api/chat/plan`) and falls
 * back to the legacy SSE stream when the server says the planner is
 * disabled, the kind isn't planned, or the call fails.
 *
 * The planner is non-streaming JSON. We reuse the chat surface's streaming
 * assistant bubble by feeding it "deltas" — the prose (plus the plan summary,
 * once it arrives) — so the UI, `aria-live` log, and typing caret behave
 * exactly like a normal coach reply.
 *
 * Contract with the parent surface:
 *   - opts.applyPlan(result)  — surface-specific rendering of each result
 *     status (ok / clarify / renegotiate / no_change / early). Receives the
 *     full pipeline payload and the streamId of the bubble it may finalize.
 *   - opts.legacySend(text)   — the surface's existing SSE send function
 *     (used for fallback). When the planner is usable the hook never calls
 *     it, so the SSE reader and the plan path can't interleave.
 *   - The hook returns 'handled" | "fallback" so the surface knows whether
 *     it must also run its own legacy send path. When the hook handled the
 *     send it has already finalized the bubbles.
 *
 * Renegotiation rounds: the surface keeps the last renegotiate payload +
 * the streamId of the assistant bubble that triggered it, so when the user
 * picks one of the four options we can re-call /chat/plan with
 * { round, choice, priorPlan, constraint } attached to the same bubble.
 */

export const PLANNED_KINDS = new Set([
  "add_goal",
  "plan_day",
  "edit_goal",
  "drop_goal",
  "review_progress",
]);

// In-flight renegotiation context. Module-level because only one chat
// modal can be open at a time (Coach.js renders one ChatModal + one
// FocusedTaskChatDialog, and they close each other).
let activeRenegotiation = null;

export function clearRenegotiation() {
  activeRenegotiation = null;
}

const RUN_RENEG_LABELS = {
  shift_existing_target: "Shifting an existing goal's target date…",
  drop_existing_commitment: "Dropping an existing commitment…",
  extend_new_timeline: "Extending this goal's timeline…",
  reduce_new_hours: "Reducing this goal's weekly hours…",
};

export function renegotiationChoiceLabel(choice) {
  return RUN_RENEG_LABELS[choice] || "Re-planning…";
}

export function getActiveRenegotiation() {
  return activeRenegotiation;
}

/**
 * @param {object} opts
 * @param {string} kind            conversation kind (planned or 'general')
 * @param {string|null} refId      current conversation bucket id
 * @param {string} title           scoped title ("" if none)
 * @param {string} helperText      scoped helper line ("" if none)
 * @param {boolean} autoAnswer
 * @param {boolean} grillMe
 * @param {function} setMessages   surface's messages state setter
 * @param {function} setSending
 * @param {(result: object, ctx: { streamId: string }) => void} applyPlan
 */
export function usePlanSend({
  kind,
  scope,
  refIdRef,
  title,
  helperText,
  autoAnswer,
  grillMe,
  sources = [],
  setMessages,
  applyPlan,
}) {
  const [applyingPlan, setApplyingPlan] = useState(false);

  /**
   * Try the planner for `text`. Returns true if it handled the send
   * (caller should NOT also run the legacy send); false if the caller
   * should run its legacy SSE path.
   */
  const tryPlan = useCallback(
    async (text, streamId) => {
      const reneg = activeRenegotiation;
      // A renegotiation answer must go through the pipeline even if the
      // user's literal next message wouldn't otherwise qualify.
      const isRenegRound = !!reneg && reneg.refId === (refIdRef?.current ?? null);

      if (!PLANNED_KINDS.has(kind) && !isRenegRound) return false;

      let handled = false;
      try {
        setApplyingPlan(true);
        // The bubble stays empty while the (non-streaming) planner runs;
        // ChatConsole renders a small grey status for an empty streaming
        // message, so the warm-up reads as progress, not as a reply.
        const body = {
          message: text,
          kind,
          scope,
          refId: refIdRef?.current ?? null,
          title,
          helperText,
          auto_answer: autoAnswer,
          grillMe,
          sourceIds: sources.map((source) => source.id).filter(Boolean),
        };
        if (reneg && reneg.refId === (refIdRef?.current ?? null)) {
          body.renegotiation = {
            round: reneg.round,
            choice: reneg.choice,
            priorPlan: reneg.priorPlan,
            // One-line instruction for Stage 3's re-plan. Keeps the plan
            // deterministic-ish: the choice names the lever to pull.
            constraint: renegotiationChoiceLabel(reneg.choice),
          };
          activeRenegotiation = null; // consumed
        }
        const result = await api.plan(body);

        // Disabled / not planned / pipeline stage failure (`no_change` only
        // ever means a stage failed in this pipeline) — fall through to the
        // streaming chat path so the user still gets a real reply instead of
        // a dead-end "no changes needed" bubble.
        if (
          result?.status === "disabled" ||
          result?.status === "not_planned" ||
          result?.status === "no_change"
        ) {
          return false;
        }

        if (result?.status === "renegotiate") {
          // Park the context so the option click re-calls the pipeline.
          activeRenegotiation = {
            refId: refIdRef?.current ?? null,
            round: (body.renegotiation?.round ?? 0) + 1,
            choice: null,
            priorPlan: result.plan,
          };
        } else {
          activeRenegotiation = null;
        }

        applyPlan?.(result, { streamId });
        handled = true;
        return true;
      } catch (e) {
        // Planner-specific failure on a planned kind. The SSE path can't
        // reproduce the negotiation UX, but a totally silent failure is
        // worse than a note — surface a toast and still fall back so the
        // user gets a reply.
        if (PLANNED_KINDS.has(kind)) {
          console.warn("[planner] pipeline failed; falling back to chat", e);
        }
        return false;
      } finally {
        if (!handled) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamId
                ? { ...m, content: '', streaming: true }
                : m,
            ),
          );
        }
        setApplyingPlan(false);
      }
    },
    [kind, scope, refIdRef, title, helperText, autoAnswer, grillMe, sources, setMessages, applyPlan],
  );

  return { tryPlan, applyingPlan };
}
