import { toast } from "sonner";
import { PROGRESS_RULES, PROGRESS_SHOW_AFTER_MS, PROGRESS_STEP_MS } from "../constants/progress";

let nextId = 0;

/** The steps to show for this request, or null when it is not a slow one. */
function ruleFor(method, path) {
  return PROGRESS_RULES.find((r) => r.methods.includes(method) && r.path.test(path.split("?")[0])) || null;
}

/**
 * Run `work()`; if it is a slow kind of request and takes a moment, show a loading toast that walks
 * through plain-language steps until it finishes. Quick requests show nothing.
 */
export async function withProgress(method, path, work) {
  const rule = ruleFor(method, path);
  if (!rule) return work();
  const { steps, showAfterMs = PROGRESS_SHOW_AFTER_MS } = rule;

  const id = `progress-${++nextId}`;
  let index = 0;
  let stepTimer = null;
  const showTimer = setTimeout(() => {
    toast.loading(steps[0], { id, duration: Infinity });
    stepTimer = setInterval(() => {
      index = Math.min(index + 1, steps.length - 1);
      toast.loading(steps[index], { id, duration: Infinity });
    }, PROGRESS_STEP_MS);
  }, showAfterMs);

  try {
    return await work();
  } finally {
    clearTimeout(showTimer);
    if (stepTimer) clearInterval(stepTimer);
    toast.dismiss(id);
  }
}
