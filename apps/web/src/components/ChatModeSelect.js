import { useEffect, useRef, useState } from "react";
import { ChevronDown, Sparkles, HelpCircle, Zap } from "lucide-react";

/**
 * ChatModeSelect — replaces the two-toggle button pair with a single
 * 3-option dropdown. Ask is the default; Auto assumes low-impact details,
 * while Grill keeps asking until the plan is specific.
 *
 * Modes:
 *   - "coach"  (default) — Ask for missing details that materially change
 *     the plan; assume the rest.
 *   - "auto"             — coach makes reasonable assumptions and just
 *     proposes (auto-answer mode).
 *   - "grill"            — coach pushes back: keeps asking until it has
 *     enough specifics to propose something concrete.
 */
const MODES = [
  { id: "coach", label: "Ask me", shortLabel: "ask", description: "Ask for missing details that materially change the plan; assume the rest.", icon: HelpCircle },
  { id: "auto",  label: "Auto", shortLabel: "auto", description: "Make reasonable assumptions and propose the plan now.", icon: Sparkles },
  { id: "grill", label: "Grill me", shortLabel: "grill", description: "Keep asking tailored questions until you have enough to plan.", icon: Zap },
];

export default function ChatModeSelect({ autoAnswer, grillMe, setAutoAnswer, setGrillMe, initialOpen = false }) {
  const [open, setOpen] = useState(initialOpen);
  const wrapRef = useRef(null);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const currentId = grillMe ? "grill" : autoAnswer ? "auto" : "coach";
  const current = MODES.find((m) => m.id === currentId);
  const CurrentIcon = current?.icon || HelpCircle;

  const pick = (id) => {
    setOpen(false);
    if (id === "coach") {
      setAutoAnswer(false);
      setGrillMe(false);
    } else if (id === "auto") {
      setAutoAnswer(true);
      setGrillMe(false);
    } else if (id === "grill") {
      setGrillMe(true);
      setAutoAnswer(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative" data-testid="chat-mode-select">
      <button
        type="button"
        data-testid="chat-mode-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Coach mode: ${current.label}`}
        onClick={() => setOpen((v) => !v)}
        className={`h-11 w-full flex items-center justify-around gap-1.5 font-mono text-[10px] uppercase tracking-wider px-2 py-2 rounded border whitespace-nowrap transition-colors overflow-hidden ${
          open
            ? "border-[var(--border-accent)] text-[var(--text-primary)]"
            : currentId === "grill"
            ? "border-[var(--danger)] text-[var(--danger)]"
            : currentId === "auto"
            ? "border-[var(--accent)] text-[var(--accent)]"
            : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        }`}
      >
        <CurrentIcon className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{current.shortLabel || current.label}</span>
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          data-testid="chat-mode-menu"
          role="listbox"
          aria-label="Chat mode"
          className="absolute bottom-full left-0 mb-1.5 z-10 w-64 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md shadow-lg overflow-hidden"
        >
          {MODES.map((m) => {
            const Icon = m.icon;
            const selected = m.id === currentId;
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={selected}
                data-testid={`chat-mode-option-${m.id}`}
                onClick={() => pick(m.id)}
                className={`w-full text-left flex items-start gap-2 px-3 py-2 transition-colors ${
                  selected ? "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--accent)]" : "hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                }`}
              >
                <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${selected ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium">{m.label}</div>
                  <div className="text-[10px] text-[var(--text-muted)] leading-snug">{m.description}</div>
                </div>
                {selected && (
                  <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-[var(--accent)] shrink-0">
                    on
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
