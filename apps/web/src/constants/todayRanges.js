/**
 * The ranges the Today tab can show. `today` is the working list; `week` is the days of this week (Monday
 * first, like the calendar), each with its own list; `month` is a summary of this calendar month.
 */
export const TODAY_RANGE_DAY = "today";
export const TODAY_RANGE_WEEK = "week";
export const TODAY_RANGE_MONTH = "month";

export const TODAY_RANGES = [
  { key: TODAY_RANGE_DAY, label: "Today" },
  { key: TODAY_RANGE_WEEK, label: "This week" },
  { key: TODAY_RANGE_MONTH, label: "This month" },
];

/** The range remembered between visits (per browser). */
export const TODAY_RANGE_STORAGE_KEY = "sutra.todayRange";
