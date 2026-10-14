import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useSpeechCapture — press-and-hold voice capture using the browser's own speech
 * recognition (Web Speech API).
 *
 * Why in the browser: no model available to the server accepts audio, so the
 * browser turns speech into text and Scratch receives a transcript. Support is
 * uneven (Chrome and Safari yes, Firefox no), so `supported` lets the caller
 * disable the control instead of failing on tap.
 *
 * `start` on press, `stop` on release; `onFinal(transcript)` fires once, after
 * the recogniser has finished, with the full text (possibly empty).
 */

/** Recognition language. Indian English; change here, not at the call site. */
export const SPEECH_LANG = "en-IN";

const Recognition =
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined;

export function useSpeechCapture({ onFinal, lang = SPEECH_LANG }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const rec = useRef(null);
  const text = useRef("");
  const cb = useRef(onFinal);
  cb.current = onFinal;

  const start = useCallback(() => {
    if (!Recognition || rec.current) return;
    setError(null);
    text.current = "";
    const r = new Recognition();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text.current += e.results[i][0].transcript + " ";
      }
    };
    r.onerror = (e) => setError(e.error || "speech error");
    r.onend = () => {
      rec.current = null;
      setListening(false);
      cb.current?.(text.current.trim());
    };
    rec.current = r;
    setListening(true);
    r.start();
  }, [lang]);

  const stop = useCallback(() => rec.current?.stop(), []);

  useEffect(() => () => rec.current?.abort(), []);

  return { supported: Boolean(Recognition), listening, error, start, stop };
}
