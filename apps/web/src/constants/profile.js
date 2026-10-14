// The "about you" step shown once at the start of Add Goal (AboutYouCard). The server stores it in
// users.profile (apps/api/sutra_api/profile.py) and the planner reads it (apps/agentv2/core/profile.py).

/** Weekday keys, Monday first, as the API stores them. */
export const WEEKDAYS = [
  { key: "mon", label: "Mon" },
  { key: "tue", label: "Tue" },
  { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" },
  { key: "fri", label: "Fri" },
  { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

/** Pre-selected work or study days: the most common week, one tap to change. Times start empty. */
export const DEFAULT_WORK_DAYS = ["mon", "tue", "wed", "thu", "fri"];

/** Weekly hours for goals, as tap targets. "Other" opens a number field. */
export const WEEKLY_HOURS_CHOICES = [3, 5, 8, 12, 20];
export const MAX_WEEKLY_GOAL_HOURS = 112;
