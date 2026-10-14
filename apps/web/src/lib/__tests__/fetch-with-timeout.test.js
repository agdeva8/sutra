import { withTimeout, TimeoutError } from "../fetch-with-timeout";

describe("withTimeout", () => {
  it("resolves when the promise settles before timeout", async () => {
    const promise = new Promise((resolve) => setTimeout(() => resolve("success"), 10));
    const result = await withTimeout(promise, 50, "test-op");
    expect(result).toBe("success");
  });

  it("rejects with TimeoutError when operation times out", async () => {
    const hangingPromise = new Promise(() => {});
    await expect(withTimeout(hangingPromise, 20, "test-hang")).rejects.toThrow(TimeoutError);
    await expect(withTimeout(hangingPromise, 20, "test-hang")).rejects.toThrow(
      "test-hang timed out after 20ms",
    );
  });

  it("propagates abort to AbortController on timeout", async () => {
    const controller = new AbortController();
    const hangingPromise = new Promise(() => {});

    expect(controller.signal.aborted).toBe(false);

    await expect(
      withTimeout(hangingPromise, 20, "test-abort", { controller, signal: controller.signal }),
    ).rejects.toThrow(TimeoutError);

    expect(controller.signal.aborted).toBe(true);
  });

  it("propagates abort when caller aborts before timeout", async () => {
    const controller = new AbortController();
    const promise = new Promise((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new Error("aborted by caller"));
      });
    });

    const timeoutP = withTimeout(promise, 500, "test-early-abort", controller);
    controller.abort();

    await expect(timeoutP).rejects.toThrow("aborted by caller");
  });
});
