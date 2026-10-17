import { useCallback, useEffect, useRef, useState } from "react";
import { mergeTranscript, IS_ANDROID } from "../lib/speech";

/**
 * useSpeechCapture — tap to start, tap to stop, transcribing as you talk.
 *
 * Why in the browser: no model available to the server accepts audio, so the browser turns speech
 * into text and the composer receives a transcript. Support is uneven (Chrome and Safari yes, Firefox
 * no), so `supported` lets the caller disable the control instead of failing on tap.
 *
 * **Tap-to-toggle, not press-and-hold.** Hold-to-talk reads well on paper and fails in the hand: a
 * pointerup or a stray pointerleave ends the session, and on a phone the scroll gesture fires one, so
 * the mic dies before a sentence lands. A tap starts a session that runs until the user stops it.
 *
 * Three things make a long session survive, all of them learned from the chat composer:
 *
 * 1. `interimResults` is on, so `onTranscript` fires with the words so far and the person sees them
 *    appear rather than staring at a spinner.
 * 2. Chromium ends recognition by itself after roughly a minute of quiet, whatever `continuous` says.
 *    An `onend` we did not ask for restarts the session, so a long thought is never cut off.
 * 3. A silence timer ends the session after a long gap with no words at all — the one case where
 *    restarting would loop forever.
 *
 * The transcript itself is rebuilt each event by `mergeTranscript` (lib/speech.js), which is where the
 * space-joining and the drop of Android's repeated phrases live. Android runs one utterance per session
 * (see `IS_ANDROID`); desktop and iOS keep a continuous session and read each event from `e.resultIndex`.
 */

/** Recognition language. Indian English; change here, not at the call site. */
export const SPEECH_LANG = "en-IN";

/** No words at all for this long ends the session. Long on purpose: a pause to think is not an ending. */
const SILENCE_LIMIT_MS = 60_000;

/** Chromium needs a beat between `onend` and a fresh `start()`, or the start throws. */
const RESTART_DELAY_MS = 250;

const Recognition =
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined;

export function useSpeechCapture({ onTranscript, lang = SPEECH_LANG, maxChars = Infinity }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const rec = useRef(null);
  const base = useRef(""); // what was in the box when the session began
  //: Finished phrases heard in the session now running, in order. Only the tail of each `onresult` is
  //: new (`e.resultIndex`), so the earlier ones are kept here and the whole line is rebuilt each time.
  const finals = useRef([]);
  //: The line as last put in the box, interim words included. A restart continues from this, so a cut
  //: mid-phrase loses nothing.
  const shown = useRef("");
  const cb = useRef(onTranscript);
  cb.current = onTranscript;
  //: Mirrors `listening` for the long-lived recogniser callbacks, which close over one render.
  const listeningRef = useRef(false);
  listeningRef.current = listening;
  //: True while we are stopping on purpose, so `onend` does not treat it as an unexpected cut-off.
  const stopping = useRef(false);
  //: The pending restart timer. Held so `stop()` and unmount can cancel a restart that has not fired
  //: yet — nothing is running during that gap, so without this a tap there is a no-op and the mic
  //: comes back on by itself.
  const restartTimer = useRef(null);

  const emit = useCallback(
    (text) => cb.current?.(text.slice(0, maxChars)),
    [maxChars],
  );

  const stop = useCallback(() => {
    stopping.current = true;
    if (restartTimer.current) {
      clearTimeout(restartTimer.current);
      restartTimer.current = null;
    }
    try {
      rec.current?.stop();
    } catch {
      /* already stopped */
    }
    setListening(false);
  }, []);

  const start = useCallback(
    (currentText = "") => {
      if (!Recognition || rec.current) return;
      setError(null);
      base.current = currentText || "";
      finals.current = [];
      shown.current = base.current;
      const r = new Recognition();
      r.lang = lang;
      // Android can only be trusted one utterance at a time (see `IS_ANDROID`); everywhere else the
      // session stays open so a long thought is not cut at the first pause.
      r.continuous = !IS_ANDROID;
      r.interimResults = true;

      let silenceTimer = null;
      const armSilence = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => stop(), SILENCE_LIMIT_MS);
      };

      r.onresult = (e) => {
        armSilence();
        // Rebuild the whole line — what was already in the box, the phrases finished this session, and
        // the one still forming — so the box always shows what was heard. Read only from `e.resultIndex`
        // on a continuous session: the results before it were folded into `finals` on an earlier event,
        // and re-reading them is how the same words end up in the line twice. Android starts a fresh
        // session per utterance, so the whole (single-utterance) list is new and is read from the top.
        let interim = "";
        for (let i = IS_ANDROID ? 0 : e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          if (result.isFinal) finals.current.push(result[0].transcript);
          else interim += result[0].transcript;
        }
        const merged = mergeTranscript(base.current, finals.current, interim);
        shown.current = merged;
        emit(merged);
      };
      r.onerror = (e) => {
        if (silenceTimer) clearTimeout(silenceTimer);
        const why = e?.error || "unknown";
        if (why === "no-speech" || why === "aborted") return; // a pause, not a failure; `onend` decides
        if (why === "not-allowed" || why === "service-not-allowed") {
          setError("Microphone access is blocked — allow it in your browser settings.");
        } else {
          setError("Voice input stopped. Tap the mic to try again.");
        }
        stopping.current = true;
        setListening(false);
      };
      r.onend = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        rec.current = null;
        if (stopping.current || !listeningRef.current) {
          stopping.current = false;
          setListening(false);
          return;
        }
        // The browser ended us, not the user. The line as last shown becomes the new starting text, so
        // the session about to start continues from it — keeping the stale `base` let the next utterance
        // overwrite everything said before the cut, losing the beginning of a long dictation. Android
        // lands here after every utterance by design; desktop and iOS only when Chromium stops on its own.
        base.current = shown.current;
        finals.current = [];
        restartTimer.current = setTimeout(() => {
          restartTimer.current = null;
          // The user may have stopped (or the screen unmounted) during the gap, and nothing is
          // running then — so this is the only place that can honour it.
          if (stopping.current || !listeningRef.current) {
            stopping.current = false;
            setListening(false);
            return;
          }
          try {
            r.start();
            rec.current = r;
            armSilence(); // a restarted session needs its own silence guard, or a silent loop never ends
          } catch {
            setListening(false);
          }
        }, RESTART_DELAY_MS);
      };

      rec.current = r;
      stopping.current = false;
      setListening(true);
      armSilence();
      try {
        r.start();
      } catch {
        rec.current = null;
        setListening(false);
      }
    },
    [emit, lang, stop],
  );

  /** One control, two states: tap starts a session, tap again ends it. */
  const toggle = useCallback(
    (currentText = "") => {
      if (listeningRef.current) stop();
      else start(currentText);
    },
    [start, stop],
  );

  // Leaving the screen mid-sentence must not leave the microphone open — nor a pending restart
  // timer that would start it after the unmount.
  useEffect(
    () => () => {
      stopping.current = true;
      if (restartTimer.current) {
        clearTimeout(restartTimer.current);
        restartTimer.current = null;
      }
      try {
        rec.current?.abort();
      } catch {
        /* already gone */
      }
      rec.current = null;
    },
    [],
  );

  return { supported: Boolean(Recognition), listening, error, start, stop, toggle };
}
