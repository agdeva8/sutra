import { useCallback, useEffect, useRef, useState } from "react";

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
  const cb = useRef(onTranscript);
  cb.current = onTranscript;
  //: Mirrors `listening` for the long-lived recogniser callbacks, which close over one render.
  const listeningRef = useRef(false);
  listeningRef.current = listening;
  //: True while we are stopping on purpose, so `onend` does not treat it as an unexpected cut-off.
  const stopping = useRef(false);

  const emit = useCallback(
    (heard) => {
      const spoken = (heard || "").trim();
      const start = base.current;
      const joined = !start ? spoken : !spoken ? start : `${start.replace(/\s+$/, "")} ${spoken}`;
      cb.current?.(joined.slice(0, maxChars));
    },
    [maxChars],
  );

  const stop = useCallback(() => {
    stopping.current = true;
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
      const r = new Recognition();
      r.lang = lang;
      r.continuous = true;
      r.interimResults = true;

      let silenceTimer = null;
      const armSilence = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => stop(), SILENCE_LIMIT_MS);
      };

      r.onresult = (e) => {
        armSilence();
        // Every result rewrites the whole transcript — final words plus the ones still forming — so the
        // box always shows what was heard, not an append-only pile of fragments.
        let heard = "";
        for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript;
        emit(heard);
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
        // The browser ended us, not the user: pick the session back up where it left off.
        base.current = base.current; // unchanged — `emit` already folded the words in
        setTimeout(() => {
          try {
            r.start();
            rec.current = r;
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

  // Leaving the screen mid-sentence must not leave the microphone open.
  useEffect(
    () => () => {
      stopping.current = true;
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
