import { useEffect, useState } from "react";

/**
 * Whether the first-run guide (add a goal, see the timeline, meet Scratch) is still in progress.
 * While it is, nothing else asks for attention: no install sheet, no greeting toast, no calendar prompt.
 * Coach sets it; the prompts read it.
 */
let active = false;
const listeners = new Set();

export function setGuideActive(next) {
  if (active === next) return;
  active = next;
  listeners.forEach((fn) => fn());
}

export function useGuideActive() {
  const [value, setValue] = useState(active);
  useEffect(() => {
    const sync = () => setValue(active);
    listeners.add(sync);
    sync();
    return () => listeners.delete(sync);
  }, []);
  return value;
}
