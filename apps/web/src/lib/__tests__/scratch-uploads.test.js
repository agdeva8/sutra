/**
 * The background upload queue: retry with backoff, resume from storage, delete once confirmed, and only
 * settle an entry when every attachment has landed.
 *
 * A fake IndexedDB (an in-memory map behind the real `createUploadStore`) stands in for the browser store,
 * so the persistence path is exercised rather than skipped.
 */
import { createScratchUploads, UPLOAD_STATE } from "../scratchUploads";
import { createUploadStore } from "../uploadStore";

function fakeIndexedDb(seed = []) {
  const rows = new Map(seed.map((row) => [row.id, row]));
  return {
    rows,
    open() {
      const request = {};
      const objectStore = {
        put: (record) => {
          rows.set(record.id, record);
          return {};
        },
        delete: (id) => {
          rows.delete(id);
          return {};
        },
        getAll: () => {
          const request = {};
          // `all()` attaches `onsuccess` after the call returns, so answer on the next tick.
          setTimeout(() => {
            request.result = [...rows.values()];
            request.onsuccess?.();
          }, 0);
          return request;
        },
      };
      request.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => {
          const tx = { objectStore: () => objectStore };
          // Handlers are attached after `transaction()` returns, so completion must come later.
          setTimeout(() => tx.oncomplete?.(), 0);
          return tx;
        },
      };
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    },
  };
}

async function flush(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was never reached");
}

function build({ upload, seed = [], maxAttempts = 5 } = {}) {
  const factory = fakeIndexedDb(seed);
  const store = createUploadStore(factory);
  const attach = jest.fn(async () => ({ ok: true }));
  const addLink = jest.fn(async () => ({ id: "src_link" }));
  const sleeps = [];
  const queue = createScratchUploads({
    upload,
    attach,
    addLink,
    store,
    shrink: async (file) => file,
    sleep: async (ms) => sleeps.push(ms),
    maxAttempts,
  });
  const settled = jest.fn();
  queue.setSettledHandler(settled);
  return { factory, store, attach, addLink, sleeps, queue, settled };
}

test("a flaky upload retries on the named backoff, then is attached and removed from the phone", async () => {
  let attempts = 0;
  const upload = jest.fn(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("offline");
    return { id: "src_1" };
  });
  const { factory, attach, sleeps, queue, settled } = build({ upload });

  await queue.enqueue("scratch_1", { kind: "image", name: "photo.jpg", file: { name: "photo.jpg" } });
  await flush(() => settled.mock.calls.length === 1);

  expect(sleeps).toEqual([2000, 5000]);
  expect(upload).toHaveBeenCalledTimes(3);
  expect(attach).toHaveBeenCalledWith("scratch_1", "src_1");
  expect(queue.hasJobs("scratch_1")).toBe(false);
  expect(settled).toHaveBeenCalledWith("scratch_1");
  // The local copy exists only until the server has it.
  expect(factory.rows.size).toBe(0);
});

test("an upload that never lands fails visibly, keeps the file, and Retry finishes it", async () => {
  const upload = jest.fn(async () => {
    throw new Error("Load failed");
  });
  const { factory, queue, settled, sleeps } = build({ upload });

  await queue.enqueue("scratch_1", { kind: "image", name: "photo.jpg", file: { name: "photo.jpg" } });
  await flush(() => queue.stateFor("scratch_1")?.status === UPLOAD_STATE.failed);

  expect(upload).toHaveBeenCalledTimes(5);
  expect(sleeps).toEqual([2000, 5000, 15000, 60000]);
  expect(queue.stateFor("scratch_1")).toMatchObject({ status: "failed", error: "Load failed" });
  expect(queue.hasJobs("scratch_1")).toBe(true);
  expect(queue.hasPending("scratch_1")).toBe(false);
  expect(settled).not.toHaveBeenCalled();
  // The blob is still on the phone, so Retry has something to send.
  expect(factory.rows.size).toBe(1);

  upload.mockImplementation(async () => ({ id: "src_2" }));
  expect(queue.retryEntry("scratch_1")).toBe(true);
  await flush(() => settled.mock.calls.length === 1);

  expect(factory.rows.size).toBe(0);
  expect(queue.stateFor("scratch_1")).toBeNull();
});

test("a new visit resumes an upload a closed tab left in storage", async () => {
  const file = { name: "syllabus.pdf", size: 10 };
  const upload = jest.fn(async () => ({ id: "src_resumed" }));
  const seed = [{ id: "up_old", entryId: "scratch_9", kind: "file", name: "syllabus.pdf", file, url: "", excerpt: "" }];
  const { factory, attach, queue, settled } = build({ upload, seed });

  await queue.resume();
  await flush(() => settled.mock.calls.length === 1);

  expect(upload).toHaveBeenCalledWith(file);
  expect(attach).toHaveBeenCalledWith("scratch_9", "src_resumed");
  expect(factory.rows.size).toBe(0);
});

test("an entry is not settled until every attachment is confirmed", async () => {
  const pending = [];
  const upload = jest.fn(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  const { queue, settled } = build({ upload });

  await queue.enqueue("scratch_1", { kind: "image", name: "one.jpg", file: { name: "one.jpg" } });
  await queue.enqueue("scratch_1", { kind: "image", name: "two.jpg", file: { name: "two.jpg" } });
  await flush(() => pending.length === 2);

  pending[0]({ id: "src_one" });
  await flush(() => queue.jobs().length === 1);
  // One attachment is up; processing must still wait for the other.
  expect(settled).not.toHaveBeenCalled();

  pending[1]({ id: "src_two" });
  await flush(() => settled.mock.calls.length === 1);
  expect(settled).toHaveBeenCalledTimes(1);
});

test("a link is added through the same queue, with no upload", async () => {
  const upload = jest.fn();
  const { addLink, queue, settled } = build({ upload });

  await queue.enqueue("scratch_1", { kind: "link", name: "https://example.com", url: "https://example.com", excerpt: "A page" });
  await flush(() => settled.mock.calls.length === 1);

  expect(upload).not.toHaveBeenCalled();
  expect(addLink).toHaveBeenCalledWith("https://example.com", "A page");
});
