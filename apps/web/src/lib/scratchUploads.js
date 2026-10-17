/**
 * The background upload queue behind a Scratch note.
 *
 * Capture has to be instant, so Send creates the entry and returns; every photo or link rides here
 * afterwards. For a photo the queue first shrinks it (`imageShrink`), then uploads it by whichever route
 * `api.uploadSource` picks, then confirms the resulting source onto its entry
 * (`POST /scratch/{id}/sources`). Only when every attachment of an entry is confirmed does the entry get
 * filed — `onSettled(entryId)` is the cue for `ScratchScreen` to call `POST /scratch/{id}/process`.
 *
 * Nothing is lost while it flies: a job is written to `uploadStore` (IndexedDB, or memory when the
 * browser refuses one) before its upload starts, and removed only after the server confirms it. A
 * failed job keeps its blob so Retry can pick it up, and `resume()` re-runs anything a closed tab left
 * behind.
 *
 * Retries use a named backoff, not a tight loop: a phone that has just lost signal needs seconds, not
 * milliseconds, and hammering the API on a dead network only drains the battery.
 */
import { MAX_UPLOAD_ATTEMPTS, UPLOAD_BACKOFF_MS } from "../constants/limits";
import { api } from "./api";
import { shrinkPhoto } from "./imageShrink";
import { createUploadStore } from "./uploadStore";

/** What the queue is doing with one attachment, as the row shows it. */
export const UPLOAD_STATE = {
  uploading: "uploading",
  retrying: "retrying",
  failed: "failed",
};

/** Where an attachment lives before Send: a file and/or a link the composer holds. */
export const ATTACHMENT_KIND = { image: "image", file: "file", link: "link" };

const RETRY_BACKOFF = (index) =>
  UPLOAD_BACKOFF_MS[Math.min(index, UPLOAD_BACKOFF_MS.length - 1)];

/** A sentence for the row, from whatever the upload threw. */
export function uploadFailureMessage(error) {
  if (error?.message) return error.message;
  return "Upload failed.";
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sequence = 0;

/**
 * The queue. `upload`/`attach`/`addLink` are injected so tests drive it without a network, and so this
 * module never has to know how the API signs an upload.
 */
export function createScratchUploads({
  upload,
  attach,
  addLink,
  store = createUploadStore(),
  shrink = shrinkPhoto,
  sleep = wait,
  backoff = RETRY_BACKOFF,
  maxAttempts = MAX_UPLOAD_ATTEMPTS,
} = {}) {
  const jobs = new Map();
  const listeners = new Set();
  const settledEntries = new Set();
  let settledHandler = null;

  const view = (job) => ({
    id: job.id,
    entryId: job.entryId,
    kind: job.kind,
    name: job.name,
    status: job.status,
    attempt: job.attempt,
    maxAttempts,
    error: job.error,
  });

  function emit() {
    const snapshot = {};
    for (const job of jobs.values()) snapshot[job.id] = view(job);
    for (const listener of listeners) listener(snapshot);
  }

  function entryJobs(entryId) {
    return [...jobs.values()].filter((job) => job.entryId === entryId);
  }

  /** The one state a row shows for an entry: a failure outranks a retry, which outranks an upload. */
  function stateFor(entryId) {
    const list = entryJobs(entryId);
    if (!list.length) return null;
    return view(
      list.find((job) => job.status === UPLOAD_STATE.failed) ||
        list.find((job) => job.status === UPLOAD_STATE.retrying) ||
        list.find((job) => job.status === UPLOAD_STATE.uploading) ||
        list[0],
    );
  }

  function maybeSettled(entryId) {
    if (settledEntries.has(entryId) || entryJobs(entryId).length > 0) return;
    settledEntries.add(entryId);
    settledHandler?.(entryId);
  }

  /** The bytes (or the link) the network should send for this job. */
  async function payload(job) {
    if (job.kind === ATTACHMENT_KIND.link) return null;
    if (!job.shrunk) {
      job.shrunk = await shrink(job.file);
    }
    return job.shrunk;
  }

  async function run(job) {
    for (job.attempt = 1; job.attempt <= maxAttempts; job.attempt += 1) {
      job.status = UPLOAD_STATE.uploading;
      job.error = "";
      emit();
      try {
        const source =
          job.kind === ATTACHMENT_KIND.link
            ? await addLink(job.url, job.excerpt)
            : await upload(await payload(job));
        if (!source?.id) throw new Error("The upload didn't come back with a file.");
        await attach(job.entryId, source.id);
        // The server has it now, so the phone no longer has to keep it.
        await store.remove(job.id);
        jobs.delete(job.id);
        emit();
        maybeSettled(job.entryId);
        return;
      } catch (error) {
        job.error = uploadFailureMessage(error);
        if (job.attempt >= maxAttempts) {
          job.status = UPLOAD_STATE.failed;
          emit();
          return;
        }
        job.status = UPLOAD_STATE.retrying;
        emit();
        await sleep(backoff(job.attempt - 1));
      }
    }
  }

  /** Persist the job, then start it. Resolves once the upload is under way, not when it finishes. */
  async function enqueue(entryId, attachment) {
    sequence += 1;
    const job = {
      id: `up_${Date.now()}_${sequence}`,
      entryId,
      kind: attachment.kind || ATTACHMENT_KIND.file,
      name: attachment.name || attachment.file?.name || attachment.url || "Attachment",
      file: attachment.file || null,
      url: attachment.url || "",
      excerpt: attachment.excerpt || "",
      status: UPLOAD_STATE.uploading,
      attempt: 1,
      error: "",
    };
    jobs.set(job.id, job);
    settledEntries.delete(entryId);
    emit();
    try {
      await store.put({
        id: job.id,
        entryId: job.entryId,
        kind: job.kind,
        name: job.name,
        file: job.file,
        url: job.url,
        excerpt: job.excerpt,
      });
    } catch {
      // A store that cannot even take it in memory still uploads; only reload-survival is lost.
    }
    run(job);
  }

  /** Re-enqueue everything a previous visit left unfinished. Safe to call on every mount. */
  async function resume() {
    let records = [];
    try {
      records = await store.all();
    } catch {
      return;
    }
    for (const record of records) {
      if (!record?.id || jobs.has(record.id)) continue;
      if (!record.file && !record.url) {
        await store.remove(record.id).catch(() => {});
        continue;
      }
      jobs.set(record.id, {
        ...record,
        status: UPLOAD_STATE.uploading,
        attempt: 1,
        error: "",
      });
      settledEntries.delete(record.entryId);
    }
    emit();
    for (const job of [...jobs.values()]) run(job);
  }

  /** Retry every failed attachment for one entry, from the first backoff again. */
  function retryEntry(entryId) {
    const failed = entryJobs(entryId).filter((job) => job.status === UPLOAD_STATE.failed);
    if (!failed.length) return false;
    settledEntries.delete(entryId);
    for (const job of failed) run(job);
    return true;
  }

  return {
    enqueue,
    resume,
    retryEntry,
    stateFor,
    /** Any attachment at all, confirmed or not — processing must wait while this is true. */
    hasJobs: (entryId) => entryJobs(entryId).length > 0,
    /** Whether this entry still has an unconfirmed attachment. */
    hasPending: (entryId) => entryJobs(entryId).some((job) => job.status !== UPLOAD_STATE.failed),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Called once every attachment of an entry is confirmed; the screen files the entry then. */
    setSettledHandler(handler) {
      settledHandler = handler;
    },
    /** Test/debug readout. */
    jobs: () => [...jobs.values()].map(view),
  };
}

/**
 * The one queue the Scratch screen uses. It is module-level on purpose: the user can leave the tab
 * while uploads run, and a new screen instance must attach to the same in-flight work rather than
 * start a second copy of it.
 */
export const scratchUploads = createScratchUploads({
  upload: (file) => api.uploadSource(file, "", { temporary: true }),
  attach: (entryId, sourceId) => api.attachScratchSource(entryId, sourceId),
  addLink: (url, excerpt) =>
    api.addLink({ url, temporary: true, ...(excerpt ? { text: excerpt } : {}) }),
});
