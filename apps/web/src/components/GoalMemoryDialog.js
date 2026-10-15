import { useEffect, useRef, useState } from "react";
import { Camera, Link2, Loader2, Image as ImageIcon } from "lucide-react";
import AutoTextarea from "./AutoTextarea";
import { toast } from "sonner";
import CenteredDialog from "./CenteredDialog";
import { useWebcamCapture } from "./WebcamCaptureDialog";
import { api, sourceDownloadUrl } from "../lib/api";
import { usePersistentState } from "../hooks/useDraftPersistence";

/**
 * GoalMemoryDialog — add a memory (photo or Instagram URL) attached to
 * a specific goal. Lives in the goal card action row so the user can
 * anchor a memory without navigating to the Memories tab.
 *
 * Two tabs mirror the Memories tab's add form: Photo (file upload
 * through the existing source pipeline) and Instagram (URL with shape
 * validation). Saves call `onSaved` so the parent can refresh state.
 */
export default function GoalMemoryDialog({ open, onClose, goalId, goalTitle, onSaved }) {
  const draftKey = goalId ?? "none";
  const [kind, setKind] = usePersistentState(`goal-memory:${draftKey}:kind`, "photo");
  const [file, setFile] = useState(null);
  const [url, setUrl] = usePersistentState(`goal-memory:${draftKey}:url`, "");
  const [caption, setCaption] = usePersistentState(`goal-memory:${draftKey}:caption`, "");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const fileRef = useRef(null);
  const { openCamera, cameraUi } = useWebcamCapture((f) => { setFile(f); setSubmitError(""); });

  // What is already on this goal. The dialog answers "what's here?" as well as "add one" — opening it
  // used to show a blank form, which read as "nothing is attached" even when things were.
  //
  // `/memories` returns the user's whole set and the goal filter happens here: a goal holds a handful,
  // and a per-goal endpoint would be a second shape to keep in step with this one for no gain.
  const [existing, setExisting] = useState([]);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    api
      .memories()
      .then((all) => { if (live) setExisting((all || []).filter((m) => (m.goal_id || "") === (goalId || ""))); })
      .catch(() => { if (live) setExisting([]); });
    return () => { live = false; };
  }, [open, goalId]);

  const reset = () => {
    setKind("photo");
    setFile(null);
    setUrl("");
    setCaption("");
    setSubmitting(false);
    setSubmitError("");
  };

  // Dismissing keeps the draft (url/caption/kind) for the app session; only a
  // successful save clears it.
  const close = () => {
    onClose?.();
  };
  const finish = () => {
    reset();
    onClose?.();
  };

  const submitPhoto = async () => {
    if (!file) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      // Re-use the sources pipeline so the bytes land in the same
      // storage bucket as everything else — but as a `memory`, not a `source`. The purpose is what
      // keeps a keepsake photo out of the Sources list; without it the same file shows up in both.
      const source = await api.uploadSource(file, goalId || "", { purpose: "memory" });
      await api.createMemory({
        kind: "photo",
        source_id: source.id,
        caption,
        goal_id: goalId || "",
      });
      toast.success("Memory attached to goal");
      onSaved?.();
      finish();
    } catch (e) {
      setSubmitError(e?.message || "Could not save photo memory");
    } finally {
      setSubmitting(false);
    }
  };

  const submitInstagram = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!/^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?/.test(trimmed)) {
      setSubmitError("That doesn't look like an Instagram post URL — paste a link like instagram.com/p/...");
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      await api.createMemory({
        kind: "instagram",
        external_url: trimmed,
        caption,
        goal_id: goalId || "",
      });
      toast.success("Memory attached to goal");
      onSaved?.();
      finish();
    } catch (e) {
      setSubmitError(e?.message || "Could not save Instagram memory");
    } finally {
      setSubmitting(false);
    }
  };

  const submit = () => (kind === "photo" ? submitPhoto() : submitInstagram());

  const canSubmit = submitting
    ? false
    : kind === "photo"
    ? !!file
    : !!url.trim();

  return (
    <CenteredDialog
      open={open}
      onClose={close}
      testId="goal-memory-dialog"
      icon={Camera}
      title={goalTitle ? `Add memory · ${goalTitle}` : "Add memory to this goal"}
      subtitle="A photo or post that anchors what this goal really means."
      maxWidth="max-w-md"
    >
      <div className="space-y-4">
        {/* What is already attached, above the form that adds more. */}
        {existing.length > 0 && (
          <div data-testid="goal-memory-existing" className="space-y-2">
            <p className="text-[11px] font-mono uppercase tracking-widest text-[var(--text-muted)]">
              Already on this goal ({existing.length})
            </p>
            <ul className="grid grid-cols-3 gap-2">
              {existing.map((m) => (
                <li
                  key={m.id}
                  className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
                >
                  {m.source_id ? (
                    <img
                      src={sourceDownloadUrl(m.source_id)}
                      alt={m.caption || "Memory"}
                      className="h-20 w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-20 w-full items-center justify-center text-[var(--text-muted)]">
                      <Link2 className="h-4 w-4" aria-hidden="true" />
                    </span>
                  )}
                  {m.caption && (
                    <p className="truncate px-1.5 py-1 text-[11px] text-[var(--text-muted)]">{m.caption}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Kind tabs */}
        <div className="inline-flex rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)] p-0.5">
          <button
            type="button"
            data-testid="goal-memory-kind-photo"
            onClick={() => { setKind("photo"); setSubmitError(""); }}
            className={`px-3 h-11 text-[11px] font-mono uppercase tracking-widest transition-colors flex items-center gap-1.5 rounded ${
              kind === "photo"
                ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--accent)]"
            }`}
          >
            <Camera className="w-3.5 h-3.5" aria-hidden="true" /> Photo
          </button>
          <button
            type="button"
            data-testid="goal-memory-kind-instagram"
            onClick={() => { setKind("instagram"); setSubmitError(""); }}
            className={`px-3 h-11 text-[11px] font-mono uppercase tracking-widest transition-colors flex items-center gap-1.5 rounded ${
              kind === "instagram"
                ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                : "text-[var(--text-secondary)] hover:text-[var(--accent)]"
            }`}
          >
            <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> Instagram
          </button>
        </div>

        {/* Inputs */}
        {kind === "photo" ? (
          <div className="space-y-2">
            <input
              ref={fileRef}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
              onChange={(e) => { setFile(e.target.files?.[0] || null); setSubmitError(""); }}
              data-testid="goal-memory-file-input"
            />
            {cameraUi}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                data-testid="goal-memory-file-button"
                className="flex items-center justify-center gap-2 h-11 border border-[var(--border)] hover:border-[var(--border-accent)] text-sm text-[var(--text-secondary)] rounded-xl transition-colors"
              >
                <ImageIcon className="w-4 h-4" aria-hidden="true" />
                Choose file
              </button>
              <button
                type="button"
                onClick={openCamera}
                data-testid="goal-memory-camera-button"
                className="flex items-center justify-center gap-2 h-11 border border-[var(--border)] hover:border-[var(--border-accent)] text-sm text-[var(--text-secondary)] rounded-xl transition-colors"
              >
                <Camera className="w-4 h-4" aria-hidden="true" />
                Take photo
              </button>
            </div>
            {file && (
              <div className="text-[11px] text-[var(--text-muted)] truncate">
                {file.name} · {Math.round(file.size / 1024)} KB
              </div>
            )}
          </div>
        ) : (
          <div>
            <label htmlFor="goal-memory-instagram-url" className="block text-[11px] font-mono uppercase tracking-widest text-[var(--text-muted)] mb-1.5">
              Instagram URL
            </label>
            <input
              id="goal-memory-instagram-url"
              data-testid="goal-memory-instagram-input"
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setSubmitError(""); }}
              placeholder="https://www.instagram.com/p/..."
              className="w-full h-11 bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-accent)]"
            />
          </div>
        )}

        {/* Caption */}
        <div>
          <label htmlFor="goal-memory-caption" className="block text-[11px] font-mono uppercase tracking-widest text-[var(--text-muted)] mb-1.5">
            Why this memory matters <span className="opacity-60">(optional)</span>
          </label>
          <AutoTextarea
            id="goal-memory-caption"
            data-testid="goal-memory-caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            minRows={2}
            maxRows={5}
            placeholder="What's the why behind this memory?"
            className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm leading-[22px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-accent)]"
          />
        </div>

        {/* Error */}
        {submitError && (
          <p
            data-testid="goal-memory-error"
            className="text-xs text-[var(--danger)] leading-relaxed"
            role="alert"
          >
            {submitError}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={close}
            data-testid="goal-memory-cancel"
            className="h-11 px-4 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] rounded"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            data-testid="goal-memory-save"
            className="h-11 flex items-center gap-2 px-4 rounded bg-[var(--accent)] text-[var(--bg-primary)] font-medium text-xs disabled:opacity-40 hover:opacity-90 active:scale-[0.98] transition-[opacity,transform] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
            {submitting ? "Saving…" : "Attach memory"}
          </button>
        </div>
      </div>
    </CenteredDialog>
  );
}
