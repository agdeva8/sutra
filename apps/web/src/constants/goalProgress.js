/** How a progress status looks. The server sends the status word; this is the only place it gets a name and a colour. */
export const PROGRESS_STATUS = {
  ahead: { label: "Ahead", color: "var(--success)" },
  on_track: { label: "On track", color: "var(--success)" },
  drifting: { label: "Drifting", color: "var(--warning)" },
  behind: { label: "Behind", color: "var(--danger)" },
  not_started: { label: "Not started", color: "var(--text-muted)" },
};

export const PROGRESS_FALLBACK = { label: "", color: "var(--text-muted)" };

export const progressStatus = (status) => PROGRESS_STATUS[status] || PROGRESS_FALLBACK;
