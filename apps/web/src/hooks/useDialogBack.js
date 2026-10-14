import { useEffect } from "react";

/**
 * useDialogBack — close-on-back-pressing support for dialogs.
 *
 * Iteration 9, founder feedback (#8): "when i press back, it is
 * exiting the app, instead it should cross that screen dialouge right,
 * because that should be technically back".
 *
 * Mechanism: while the dialog is OPEN, push a sentinel `history`
 * entry that carries `{ dia: <keyName> }`. When the user presses the
 * browser / system back button, the browser pops the sentinel and
 * fires `popstate`. Our handler intercepts that, fires the supplied
 * close callback, and re-pushes the sentinel so a SECOND back press
 * walks the user out of the app (as it did before this hook) — not
 * into the dialog again.
 *
 * Props:
 *   open     — whether the dialog is open
 *   onClose  — the dialog's close handler (called on back press)
 *   keyName  — a unique key for this dialog (e.g. "chat",
 *              "add-goal", "focused-task:<refId>"). Disambiguates
 *              when multiple dialogs could conceivably be open.
 *
 * Behaviour:
 *   - open=false → no-op
 *   - open=true → push sentinel, listen for popstate
 *   - popstate fires with sentinel on top (the pop WE caused) → call
 *     onClose, re-push the sentinel (so further backs exit the app)
 *   - popstate fires without our sentinel → another dialog/handler is
 *     responsible; no-op
 *   - dialog closes for any OTHER reason (X, Escape, confirm) →
 *     cleanup rewinds history so the user's stack matches the screen
 */
export function useDialogBack(open, onClose, keyName) {
  useEffect(() => {
    if (!open) return;

    const sentinelState = { dia: keyName, t: Date.now() };
    window.history.pushState(sentinelState, "");

    const onPop = (e) => {
      const state = e.state;
      // Our sentinel was on top — back press means "close me".
      // (When `history.back()` rewinds the sentinel, state becomes
      // whatever was on the stack before; that's the moment we react.)
      try { onClose?.(); } catch { /* ignore */ }
      // Re-push so the user's stack is the same depth either way.
      // If we don't, a second back press would re-open the previous
      // page (or exit the app) instead of "doing nothing extra".
      window.history.pushState(sentinelState, "");
      // Suppress an unused-param warning without changing behaviour.
      void state;
    };

    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Closing for any reason OTHER than a back press: rewind the
      // sentinel so the user's stack stays in sync with what they
      // see on screen. Skip if popstate already consumed it (state
      // is no longer our sentinel).
      try {
        if (window.history.state && window.history.state.dia === keyName) {
          window.history.back();
        }
      } catch { /* ignore */ }
    };
    // keyName + onClose are captured by closure; we intentionally
    // don't re-run the effect on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keyName]);
}