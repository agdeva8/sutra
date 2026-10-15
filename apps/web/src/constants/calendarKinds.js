/**
 * How each kind of thing looks on the calendar: a symbol, a colour and a texture, so a card can be told
 * apart at a glance without reading it. One table, so Day, Week, Month, 3 Months and Year all agree.
 *
 * Tasks and time slots take their goal's colour (so a goal reads as one colour everywhere), and every other
 * kind has a colour of its own that no goal uses.
 *   - `color: null` means "the goal's colour".
 *   - `look`: "wash" is the usual light fill; "stripes" is hatched, for time that is taken away.
 */
export const KIND_STYLE = {
  task: { glyph: "○", label: "Task", color: null, look: "wash" },
  session: { glyph: "◷", label: "Time slot", color: null, look: "wash" },
  fixed: { glyph: "▣", label: "Fixed commitment", color: "var(--text-secondary)", look: "wash" },
  blocker: { glyph: "▲", label: "Away", color: "var(--danger)", look: "stripes" },
  milestone: { glyph: "◆", label: "Milestone", color: null, look: "wash" },
  reminder: { glyph: "✦", label: "Reminder", color: "var(--reminder)", look: "wash" },
};

/** A reminder is drawn as a short slot at its time; this is how long. */
export const REMINDER_SLOT_MINUTES = 30;
