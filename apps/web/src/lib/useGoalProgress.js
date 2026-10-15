import { useEffect, useState } from "react";
import { loadGoalProgress } from "./goalProgress";

/** `{ [goalId]: progress }`: numbers first, verdicts a moment later. Reloads when `refreshKey` changes (a task was ticked). */
export default function useGoalProgress(refreshKey) {
  const [byGoal, setByGoal] = useState({});
  useEffect(() => {
    let live = true;
    loadGoalProgress(String(refreshKey ?? ""), (numbers) => live && setByGoal(numbers))
      .then((full) => live && setByGoal(full))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [refreshKey]);
  return byGoal;
}
