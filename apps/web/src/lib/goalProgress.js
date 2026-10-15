import { api } from "./api";

/**
 * Goal progress, loaded once however many screens ask for it.
 *
 * `GET /agent/progress` returns the numbers at once. If any verdict is stale, `POST /agent/progress/judge`
 * asks the model for fresh ones (a few seconds), so the screen shows numbers first and the words after.
 * Two screens mounting together share one in-flight load instead of paying for two judgements.
 */
let inflight = null;
let inflightKey = null;

const index = (goals) => Object.fromEntries((goals || []).map((g) => [g.goal_id, g]));

export function loadGoalProgress(key, onNumbers) {
  if (inflight && inflightKey === key) return inflight;
  inflightKey = key;
  inflight = (async () => {
    const first = await api.goalProgress();
    onNumbers?.(index(first.goals));
    if (!(first.goals || []).some((g) => g.stale)) return index(first.goals);
    try {
      return index((await api.judgeProgress()).goals);
    } catch {
      return index(first.goals); // no verdict is a quieter failure than no numbers
    }
  })().finally(() => {
    if (inflightKey === key) inflight = null;
  });
  return inflight;
}
