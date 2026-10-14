import { useState } from "react";
import { X, Info } from "lucide-react";

export default function OnboardingBanner() {
  const [open, setOpen] = useState(() => localStorage.getItem("gc_onboard_dismissed") !== "1");
  if (!open) return null;
  const dismiss = () => { localStorage.setItem("gc_onboard_dismissed", "1"); setOpen(false); };

  return (
    <div data-testid="onboarding-banner" className="border-b border-[var(--border)] bg-[var(--tool-bg)] px-4 sm:px-6 py-3 flex items-start gap-3 gc-fade-up">
      <Info className="w-4 h-4 text-[var(--accent)] mt-0.5 shrink-0" />
      <p className="text-xs leading-relaxed text-[var(--text-secondary)] flex-1">
        This is one chat with memory. The coach reasons across all your goals at once and remembers between sessions.
        It's the only thing that writes to your tracked state — when it wants to add, change, or drop a goal or milestone,
        it proposes the change inline and you confirm it. The panel on the right shows that same state, live.
      </p>
      <button data-testid="dismiss-onboarding" onClick={dismiss} className="h-11 w-11 -mr-2 -mt-1.5 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]" aria-label="Dismiss">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
