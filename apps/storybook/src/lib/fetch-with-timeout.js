/**
 * fetch-with-timeout.js — helper for racing promises with a timeout.
 *
 * Provides typed TimeoutError and withTimeout(promise, ms, label, optionsOrSignal).
 * When timeout triggers, it rejects with TimeoutError and attempts to abort
 * the associated AbortController / AbortSignal if provided.
 */

export class TimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Race a promise against a timeout.
 *
 * @param {Promise} promise - The promise to await.
 * @param {number} [ms=10000] - Timeout in milliseconds.
 * @param {string} [label="Operation"] - Context label for error message.
 * @param {AbortSignal|AbortController|{signal?: AbortSignal, controller?: AbortController}} [optionsOrSignal]
 * @returns {Promise}
 */
export function withTimeout(promise, ms = 10000, label = "Operation", optionsOrSignal) {
  let timerId;
  let onAbortListener = null;

  const target = optionsOrSignal;
  const signal =
    target?.signal ||
    (typeof AbortSignal !== "undefined" && target instanceof AbortSignal ? target : null);
  const controller =
    target?.controller ||
    (typeof AbortController !== "undefined" && target instanceof AbortController ? target : null);

  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      // On reject with timeout, attempt AbortController.abort() if caller passed a signal / controller
      try {
        if (controller && typeof controller.abort === "function") {
          controller.abort();
        } else if (signal && typeof signal.abort === "function") {
          signal.abort();
        } else if (signal?.controller && typeof signal.controller.abort === "function") {
          signal.controller.abort();
        } else if (typeof target?.abort === "function") {
          target.abort();
        }
      } catch {
        // Safe attempt
      }
      reject(new TimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);

    if (signal && typeof signal.addEventListener === "function") {
      onAbortListener = () => {
        clearTimeout(timerId);
      };
      if (signal.aborted) {
        clearTimeout(timerId);
      } else {
        signal.addEventListener("abort", onAbortListener, { once: true });
      }
    }
  });

  return Promise.race([
    Promise.resolve(promise).finally(() => {
      clearTimeout(timerId);
      if (signal && onAbortListener && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbortListener);
      }
    }),
    timeoutPromise,
  ]);
}
