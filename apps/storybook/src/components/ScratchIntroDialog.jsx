import { ArrowRight, Camera, CheckCheck, Mic, PenLine, Sparkles } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import ScratchExamples from "./ScratchExamples";

/**
 * ScratchIntroDialog — the plain-language tour of Scratch, shown when the user
 * taps the Scratch spotlight.
 *
 * Written for someone who has never heard of the feature: what it is in one line,
 * a picture of a thought turning into a plan item, four things they can do, and
 * how it ends. Closable at any time; "Open Scratch" is the only action that
 * counts as having tried it.
 */

const WAYS = [
  {
    icon: PenLine,
    title: "Type whatever's on your mind",
    body: "“Boss gave me the Q4 deck.” “Dentist Thursday 4pm.” Write it the way you'd say it.",
  },
  {
    icon: Camera,
    title: "Snap a photo",
    body: "A prescription, a whiteboard, a receipt. We read it and file what's in it.",
  },
  {
    icon: Mic,
    title: "Say it out loud",
    body: "Hold the mic, talk, let go. Good for the thought that hits you at 11pm.",
  },
  {
    icon: CheckCheck,
    title: "Tick things off",
    body: "Write “done with the Q4 deck” and it's marked done in your plan.",
  },
];

const FILED_AS = ["A task with time set aside", "A reminder", "A fixed block in your day", "A note kept in Sources"];

export default function ScratchIntroDialog({ open, onClose, onOpenScratch }) {
  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      title="Meet Scratch"
      subtitle="A place to dump a thought in three seconds. We do the filing."
      icon={Sparkles}
      maxWidth="max-w-lg"
      testId="scratch-intro-dialog"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            Maybe later
          </button>
          <button
            type="button"
            onClick={onOpenScratch}
            className="inline-flex h-10 items-center gap-1.5 rounded-full bg-[var(--accent)] px-5 text-sm font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]"
          >
            Open Scratch <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      }
    >
      {/* The pictures: something you dump, and what it becomes. */}
      <ScratchExamples />

      <ul className="mt-5 space-y-3.5">
        {WAYS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-[var(--text-primary)]">{title}</p>
              <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">{body}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-5 rounded-xl bg-[var(--bg-secondary)] px-3.5 py-3">
        <p className="text-[13px] font-semibold text-[var(--text-primary)]">What happens to it</p>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          It's filed for you as one of: {FILED_AS.join(", ").replace(/, ([^,]*)$/, " or $1")}. If we're not sure, we ask one
          quick question. Everything shows up under <strong>Handled</strong>, and any of it can be undone with one tap.
        </p>
      </div>
    </CenteredDialog>
  );
}
