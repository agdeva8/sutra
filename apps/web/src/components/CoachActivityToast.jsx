import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
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
  // Closed by the user: stays closed until the coach goes idle, so a new progress line does not bring it
  // back over the bottom nav. The goal card still shows the work in place.
  const closed = useRef(false);
  const wasIdle = useRef(true);
  useEffect(() => {
    if (items.length === 0) {
      wasIdle.current = true;
      toast.dismiss(ACTIVITY_TOAST_ID);
      return;
    }
    // New work after an idle spell gets the toast back (dismissing it at idle also fires onDismiss).
    if (wasIdle.current) closed.current = false;
    wasIdle.current = false;
    if (closed.current) return;
    const text =
      items.length > 1
        ? ACTIVITY_TOAST_MANY(items.length)
        : ACTIVITY_TOAST_WORKING(items[0].title || ACTIVITY_FALLBACK_TITLE, items[0].line);
    toast(text, {
      icon: <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />,
      id: ACTIVITY_TOAST_ID,
      duration: Infinity,
      closeButton: true,
      dismissible: true,
      onDismiss: () => {
        closed.current = true;
      },
    });
  }, [items]);
  return null;
}
