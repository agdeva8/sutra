import { useEffect, useState } from "react";
import { Download, ShieldCheck } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import { api, exportUrl } from "../lib/api";

function fmt(iso) {
  try {
    // Iteration 9 — standardized on `en-US` locale for the audit log so
    // the date format is predictable regardless of the user's browser
    // locale (was rendering as "30 Sept" in UK/AU/NL but "Sep 30" in
    // US, which made screenshots inconsistent and tripped the design
    // review). Same fix should propagate to Memories.js (uses
    // `undefined` locale) and the audit export. Tracked as a small
    // consistency follow-up for the next iteration.
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function HonestyAuditView({ open, onClose }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.audit().then(setEvents).catch(() => setEvents([])).finally(() => setLoading(false));
  }, [open]);

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={ShieldCheck}
      title={
        <span className="flex items-center gap-2">
          Honesty Audit
          <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-muted)] ml-1 font-normal">
            every state change, timestamped
          </span>
        </span>
      }
      maxWidth="max-w-2xl"
      testId="honesty-audit-view"
      footer={
        <a
          data-testid="export-audit-button"
          href={exportUrl()}
          className="min-h-11 flex items-center gap-1.5 text-xs px-3 py-3 rounded border border-[var(--border)] hover:border-[var(--border-accent)] text-[var(--text-secondary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" /> Export JSON
        </a>
      }
    >
      <div className="space-y-2">
        {loading && (
          <div className="space-y-2" aria-busy="true" aria-live="polite">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-3 border-b border-[var(--border)] pb-2 last:border-0">
                <div className="h-3 w-20 gc-skeleton shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-16 gc-skeleton" />
                  <div className="h-3 w-full gc-skeleton" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && events.length === 0 && (
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Nothing recorded yet. Every time you confirm or reject a proposed change, it's logged here —
            so you can verify the coach has been honest with you, not just trust that it was.
          </p>
        )}
        {events.map((e) => (
          <div key={e.id} className="flex items-start gap-3 border-b border-[var(--border)] pb-2 last:border-0" data-testid="audit-entry">
            <span className="font-mono text-[10px] text-[var(--text-muted)] w-24 shrink-0 pt-0.5">{fmt(e.created_at)}</span>
            <div className="min-w-0">
              <span className={`font-mono text-[10px] uppercase tracking-wider ${e.type?.startsWith("reject") ? "text-[var(--text-muted)]" : "text-[var(--accent)]"}`}>
                {e.type}
              </span>
              <div className="text-xs text-[var(--text-primary)] mt-0.5">{e.summary}</div>
            </div>
          </div>
        ))}
      </div>
    </CenteredDialog>
  );
}
