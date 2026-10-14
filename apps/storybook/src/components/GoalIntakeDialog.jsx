import { useState } from "react";
import { Loader2, Target } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import AutoTextarea from "./AutoTextarea";
import CenteredDialog from "./CenteredDialog";

/**
 * GoalIntakeDialog — add a goal by talking it through (agentv2 intake).
 *
 * The user says the goal in their own words; the agent asks at most a few short
 * questions (each with tappable answers), then shows a draft: title, effort,
 * length and milestones. Nothing is written until "Create and plan". The
 * conversation state is held here and sent back each turn; the server keeps none.
 */

const PHASE = { ASK: "ask", DRAFT: "draft", CREATING: "creating" };
const PLACEHOLDER = "What do you want to achieve, and by when?";

export default function GoalIntakeDialog({ open, onClose, onCreated }) {
  const [phase, setPhase] = useState(PHASE.ASK);
  const [text, setText] = useState("");
  const [state, setState] = useState(null);
  const [question, setQuestion] = useState(null);
  const [options, setOptions] = useState([]);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setPhase(PHASE.ASK);
    setText("");
    setState(null);
    setQuestion(null);
    setOptions([]);
    setDraft(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const send = async (message) => {
    const m = message.trim();
    if (!m || busy) return;
    setBusy(true);
    try {
      const step = await api.goalIntake(m, state);
      setState(step.state);
      setText("");
      if (step.kind === "draft") {
        setDraft(step.draft);
        setPhase(PHASE.DRAFT);
      } else {
        setQuestion(step.question);
        setOptions(step.options || []);
      }
    } catch (e) {
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't think that through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setPhase(PHASE.CREATING);
    try {
      const res = await api.goalIntakeConfirm(draft);
      toast.success("Goal created and planned");
      await onCreated?.(res);
      close();
    } catch (e) {
      toast.error(typeof e?.message === "string" ? e.message : "Couldn't create that goal. Try again.");
      setPhase(PHASE.DRAFT);
    }
  };

  return (
    <CenteredDialog
      open={open}
      onClose={close}
      title="Add a goal"
      subtitle={phase === PHASE.DRAFT ? "Check the plan before it's created." : "Tell me in your own words."}
      icon={Target}
      testId="goal-intake-dialog"
      footer={
        phase === PHASE.DRAFT || phase === PHASE.CREATING ? (
          <div className="flex w-full justify-end gap-2">
            <button type="button" onClick={reset} disabled={phase === PHASE.CREATING} className="h-10 px-4 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-40">
              Start over
            </button>
            <button type="button" onClick={create} disabled={phase === PHASE.CREATING} className="inline-flex h-10 items-center gap-2 rounded-full bg-[var(--accent)] px-5 text-sm font-semibold text-white disabled:opacity-60">
              {phase === PHASE.CREATING && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {phase === PHASE.CREATING ? "Planning…" : "Create and plan"}
            </button>
          </div>
        ) : null
      }
    >
      {phase === PHASE.ASK && (
        <div className="space-y-3">
          {question && <p className="text-[15px] font-medium text-[var(--text-primary)]">{question}</p>}
          {options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {options.map((o) => (
                <button key={o} type="button" disabled={busy} onClick={() => send(o)} className="rounded-full border border-[var(--border)] px-3.5 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50">
                  {o}
                </button>
              ))}
            </div>
          )}
          <AutoTextarea
            aria-label={question ? "Your answer" : "Your goal"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
            placeholder={question ? "Or type your own answer" : PLACEHOLDER}
            minRows={2}
            className="w-full px-3.5 py-2 text-[15px] leading-[22px] rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus-visible:border-[var(--accent)]"
          />
          <div className="flex justify-end">
            <button type="button" onClick={() => send(text)} disabled={!text.trim() || busy} className="inline-flex h-10 items-center gap-2 rounded-full bg-[var(--accent)] px-5 text-sm font-semibold text-white disabled:opacity-40">
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {question ? "Send" : "Next"}
            </button>
          </div>
        </div>
      )}

      {phase !== PHASE.ASK && draft && (
        <div className="space-y-4" data-testid="goal-intake-draft">
          <div>
            <p className="text-[17px] font-semibold text-[var(--text-primary)]">{draft.title}</p>
            <p className="mt-0.5 text-[13px] text-[var(--text-secondary)]">
              About {Math.round(draft.total_hours)} hours over {draft.deadline_weeks} weeks
            </p>
            {draft.why && <p className="mt-2 text-[13px] italic text-[var(--text-muted)]">“{draft.why}”</p>}
          </div>
          <ol className="space-y-2">
            {draft.milestones.map((m) => (
              <li key={m.title} className="flex gap-3 text-[14px] text-[var(--text-primary)]">
                <span className="w-16 shrink-0 text-[12px] pt-0.5 text-[var(--text-muted)] tabular-nums">Week {m.week}</span>
                {m.title}
              </li>
            ))}
          </ol>
        </div>
      )}
    </CenteredDialog>
  );
}
