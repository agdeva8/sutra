import { Route, CalendarClock, ShieldCheck, User, Sparkles } from "lucide-react";
import CenteredDialog from "./CenteredDialog";

// TODO(founder): replace these with your real links.
const FOUNDER = {
  name: "Devansh U. Agarwal",
  blurb: "Building Sutra as its own first user — a self-directed IC juggling a career pivot, a fitness rebuild, side projects, and a life.",
  linkedin: "https://www.linkedin.com/in/devansh-u-agarwal/",
};

const UPCOMING = [
  "Calendar view & scheduling",
  "Weekly / daily timetable builder",
  "Reminders & nudges",
  "Habit & progress trackers",
];

function Section({ icon: Icon, title, children }) {
  return (
    <div className="border-t border-[var(--border)] pt-4">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className="w-4 h-4 text-[var(--accent)]" aria-hidden="true" />
        <h3 className="font-display text-sm font-semibold tracking-tight">{title}</h3>
      </div>
      <div className="text-sm leading-relaxed text-[var(--text-secondary)]">{children}</div>
    </div>
  );
}

export default function AboutModal({ open, onClose }) {
  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={Sparkles}
      title="About Sutra"
      subtitle="let's sort your life - together."
      maxWidth="max-w-lg"
      testId="about-modal"
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-[var(--text-primary)]">
          You're running a career move, a body you want back, a side project, a relationship you keep
          meaning to invest in. Each one makes sense alone. What doesn't is what deserves attention this
          week, what's blocking what, and what you promised yourself at 11pm last Tuesday.
        </p>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          Sutra holds all of it at once, remembers across sessions, and tells you the honest thing —
          not the warm thing.
        </p>

        <Section icon={Route} title="A coach, not a to-do list">
          It doesn't just capture goals — it maps a realistic path to each one. Ask it to lay out your
          timeline and zoom from the year down to the week. It sequences milestones, pads for real life,
          and works around blockers you name (a sibling's wedding in December, a launch crunch) so the
          plan survives contact with reality.
        </Section>

        <Section icon={Sparkles} title="Upcoming — headed your way">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-1">
            {UPCOMING.map((u) => (
              <li key={u} className="flex items-center gap-2 text-xs">
                <span className="w-1 h-1 rounded-full bg-[var(--accent)]" aria-hidden="true" /> {u}
              </li>
            ))}
          </ul>
        </Section>

        <Section icon={ShieldCheck} title="Your data, privately">
          Your goals and conversations are yours alone. They're encrypted, never sold or shared with
          anyone, and not read by the team or the founder. The honesty audit lets you export everything
          at any time.
        </Section>

        <Section icon={User} title="About the founder">
          {FOUNDER.blurb}
          <div className="mt-2">
            <a
              data-testid="founder-linkedin"
              href={FOUNDER.linkedin}
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-11 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--accent)] hover:underline"
            >
              LinkedIn ↗
            </a>
          </div>
        </Section>
      </div>
    </CenteredDialog>
  );
}
