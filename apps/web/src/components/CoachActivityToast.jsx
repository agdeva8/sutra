import { useEffect } from "react";
import { toast } from "sonner";
import { useActivityList } from "../lib/goalActivity";
import { ACTIVITY_FALLBACK_TITLE, ACTIVITY_TOAST_ID, ACTIVITY_TOAST_MANY, ACTIVITY_TOAST_WORKING } from "../constants/goalActivity";

/**
 * CoachActivityToast — "Coach is working on <goal>: <what it is doing>", on whatever screen the user is on.
 *
 * The goal card shows the same thing in place; this is for everywhere else (Timeline, Today), so a plan
 * being written never looks like nothing happening. One toast, updated as the lines change, gone when idle.
 * Renders nothing itself.
 */
export default function CoachActivityToast() {
  const items = useActivityList();
  useEffect(() => {
    if (items.length === 0) {
      toast.dismiss(ACTIVITY_TOAST_ID);
      return;
    }
    const text =
      items.length > 1
        ? ACTIVITY_TOAST_MANY(items.length)
        : ACTIVITY_TOAST_WORKING(items[0].title || ACTIVITY_FALLBACK_TITLE, items[0].line);
    toast.loading(text, { id: ACTIVITY_TOAST_ID, duration: Infinity });
  }, [items]);
  return null;
}
