import { useEffect, useRef, useState } from "react";
import { Paperclip, Link2, Trash2, Send, ExternalLink, RefreshCw, AlertTriangle, Loader2, Camera, Image as ImageIcon } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import { API } from "../lib/api";
import { usePersistentState } from "../hooks/useDraftPersistence";
import { canAutofocus } from "../lib/utils";

/**
 * SourceActionDialog — single dialog surface for every source mutation
 * (upload file, add link, delete).
 *
 * The link mode now runs a two-step flow:
 *   1. User pastes a URL.
 *   2. We POST to /api/sources/link/preview and render a preview card
 *      with title, description, og:image, host, and a snippet.
 *      Private / 4xx / timeout cases show an explicit error and a
 *      "Save without preview" escape hatch so the link is still
 *      preserved (just without the parsed text body).
 *   3. User clicks "Attach link" → /api/sources/link runs as before.
 *
 * The upload mode keeps the file input and adds a clear progress line
 * ("Uploading N.png…"), error line, and keeps the dialog open while
 * the upload is in flight so the user sees the spinner (choppy UX
 * was a reported issue).
 */
export default function SourceActionDialog({
  open,
  onClose,
  mode = "upload",
  source = null,
  onUploadFile = async () => {},
  onAddLink = async () => {},
  onDeleteSource = async () => {},
  goalId = "",
  goalTitle = "",
}) {
  const fileRef = useRef(null)
  const cameraRef = useRef(null)
  const [progress, setProgress] = useState(null) // {name, status: 'uploading'|'done'|'error', msg?}

  // ----- link-mode local state -----
  const [url, setUrl] = usePersistentState("source:link:url", "")
  const [preview, setPreview] = useState(null) // null | { ok, title, description, ... }
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState("")

  useEffect(() => {
    if (!open) {
      setPreview(null)
      setPreviewError("")
      setSubmitting(false)
      setSubmitError("")
      setProgress(null)
      setPreviewing(false)
    }
  }, [open])

  const submitUpload = async (file) => {
    setProgress({ name: file.name, status: "uploading" })
    try {
      await onUploadFile(file, goalId)
      setProgress({ name: file.name, status: "done" })
      // Brief delay so the user sees the green "done" tick before we close.
      setTimeout(() => onClose?.(), 350)
    } catch (e) {
      setProgress({ name: file.name, status: "error", msg: e?.message || "Upload failed" })
    }
  }

  const runPreview = async (rawUrl) => {
    setPreview(null)
    setPreviewError("")
    setPreviewing(true)
    try {
      const res = await fetch(`${API}/sources/link/preview`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: rawUrl.trim() }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setPreview(null)
        setPreviewError(data?.error || "Could not preview this link.")
        return
      }
      const data = await res.json()
      setPreview(data)
      if (data.ok === false) {
        setPreviewError(data.error || "Could not preview this link.")
      }
    } catch (e) {
      setPreviewError(typeof e?.message === 'string' ? e.message : "Network error.")
    } finally {
      setPreviewing(false)
    }
  }

  const submitLink = async ({ skipPreview = false } = {}) => {
    const trimmed = url.trim()
    if (!trimmed) return
    setSubmitting(true)
    setSubmitError("")
    try {
      await onAddLink(trimmed, goalId)
      setUrl("")
      onClose?.()
    } catch (e) {
      setSubmitError(typeof e?.message === 'string' ? e.message : "Could not add link")
    } finally {
      setSubmitting(false)
    }
  }

  const submitDelete = async () => {
    if (!source?.id) return
    try {
      await onDeleteSource(source.id)
      onClose?.()
    } catch (e) {
      setSubmitError(typeof e?.message === 'string' ? e.message : "Could not remove source")
    }
  }

  let title = ""
  let subtitle = ""
  let body = null
  let footer = null

  if (mode === "upload") {
    title = goalTitle ? `Attach a source to "${goalTitle}"` : "Attach a source"
    subtitle = "Upload a PDF, .md, .txt, .csv, .json, .png or .jpg."
    body = (
      <div className="space-y-3">
        <input
          ref={fileRef}
          data-testid="source-upload-input"
          type="file"
          hidden
          accept=".pdf,.md,.txt,.csv,.json,.png,.jpg,.jpeg"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) submitUpload(f)
            e.target.value = ""
          }}
        />
        <input
          ref={cameraRef}
          data-testid="source-camera-input"
          type="file"
          hidden
          accept="image/*"
          capture="environment"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) submitUpload(f)
            e.target.value = ""
          }}
        />
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            data-testid="source-upload-button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center justify-center gap-2 h-11 border border-[var(--border)] hover:border-[var(--border-accent)] text-sm text-[var(--text-secondary)] rounded-xl transition-colors"
          >
            <ImageIcon className="w-4 h-4" aria-hidden="true" />
            Choose file
          </button>
          <button
            type="button"
            data-testid="source-camera-button"
            onClick={() => cameraRef.current?.click()}
            className="flex items-center justify-center gap-2 h-11 border border-[var(--border)] hover:border-[var(--border-accent)] text-sm text-[var(--text-secondary)] rounded-xl transition-colors"
          >
            <Camera className="w-4 h-4" aria-hidden="true" />
            Take photo
          </button>
        </div>
        {progress && (
          <div
            data-testid="source-upload-progress"
            className={`flex items-center gap-2 px-3 py-2 rounded border text-xs ${
              progress.status === "error"
                ? "border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)]"
                : progress.status === "done"
                  ? "border-[color-mix(in_srgb,var(--success)_30%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]"
                  : "border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] text-[var(--text-secondary)]"
            }`}
          >
            {progress.status === "uploading" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            ) : progress.status === "done" ? (
              <Paperclip className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            )}
            <span className="truncate flex-1">
              {progress.status === "uploading" && `Uploading ${progress.name}…`}
              {progress.status === "done" && `Attached ${progress.name}`}
              {progress.status === "error" && (progress.msg || `Failed to upload ${progress.name}`)}
            </span>
          </div>
        )}
      </div>
    )
    footer = null
  } else if (mode === "link") {
    title = goalTitle ? `Add a link to "${goalTitle}"` : "Add a link as a source"
    subtitle = "Paste any URL — we'll preview what's there first."
    body = (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <label className="flex-1">
            <span className="sr-only">Link URL</span>
            <input
              data-testid="source-link-input"
              autoFocus={canAutofocus()}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  if (url.trim()) runPreview(url.trim())
                }
              }}
              placeholder="https://…"
              aria-label="Link URL"
              className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--border-accent)]"
            />
          </label>
          <button
            type="button"
            data-testid="source-link-preview-btn"
            onClick={() => runPreview(url.trim())}
            disabled={!url.trim() || previewing}
            className="inline-flex items-center gap-1.5 h-11 px-3 text-xs border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-accent)] hover:text-[var(--text-primary)] rounded transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            {previewing ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Link2 className="w-3 h-3" aria-hidden="true" />}
            Preview
          </button>
        </div>

        {/* Preview card */}
        {previewing && (
          <div
            data-testid="source-link-preview-loading"
            className="rounded border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] px-3 py-2.5 text-xs text-[var(--text-muted)] flex items-center gap-2"
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Fetching metadata…
          </div>
        )}
        {preview && preview.ok && !previewing && (
          <div
            data-testid="source-link-preview-card"
            className="rounded border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-secondary)_60%,transparent)] overflow-hidden"
          >
            {preview.image && (
              <div className="aspect-[1200/630] bg-[var(--bg-tertiary)] overflow-hidden">
                <img
                  src={preview.image}
                  alt=""
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = "none"
                  }}
                />
              </div>
            )}
            <div className="p-3 space-y-1.5">
              <div className="flex items-start gap-2">
                {preview.favicon && (
                  <img
                    src={preview.favicon}
                    alt=""
                    className="w-4 h-4 mt-0.5 rounded shrink-0"
                    onError={(e) => {
                      e.currentTarget.style.display = "none"
                    }}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-muted)] truncate">
                      {preview.host}
                    </span>
                    <a
                      href={preview.final_url || preview.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--text-muted)] hover:text-[var(--accent)]"
                      title="Open in new tab"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <div className="text-sm font-medium text-[var(--text-primary)] leading-snug mt-1">
                    {preview.title || preview.final_url || preview.url}
                  </div>
                  {preview.description && (
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-3 mt-1">
                      {preview.description}
                    </p>
                  )}
                  {preview.snippet && (
                    <details className="mt-2">
                      <summary className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]">
                        text snippet
                      </summary>
                      <p className="mt-1.5 text-[11px] text-[var(--text-muted)] leading-relaxed max-h-32 overflow-y-auto">
                        {preview.snippet}
                      </p>
                    </details>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
        {previewError && !previewing && (
          <div
            data-testid="source-link-preview-error"
            className="rounded border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2.5 text-xs text-[var(--danger)] flex items-start gap-2"
          >
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="flex-1">
              <div>{previewError}</div>
              <button
                type="button"
                onClick={() => runPreview(url.trim())}
                className="mt-1 min-h-11 inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest text-[color-mix(in_srgb,var(--danger)_80%,transparent)] hover:text-[var(--danger)]"
              >
                <RefreshCw className="w-3 h-3" /> Retry
              </button>
            </div>
          </div>
        )}
        {submitError && (
          <p className="text-xs text-[var(--danger)]">{submitError}</p>
        )}
      </div>
    )
    footer = (
      <>
        <button onClick={onClose} data-testid="source-link-cancel" className="min-h-11 text-xs px-3 py-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors border border-[var(--border)] rounded">
          Cancel
        </button>
        <button
          data-testid="source-link-submit"
          onClick={() => submitLink({ skipPreview: !preview?.ok })}
          disabled={!url.trim() || submitting}
          title={
            preview?.ok
              ? "Attach with the parsed metadata"
              : preview
                ? "Preview failed — link will be saved without metadata"
                : "Preview not run yet — link will be saved without metadata"
          }
          className="min-h-11 flex items-center gap-1.5 text-xs px-3 py-3 rounded bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          <Send className="w-3 h-3" />{" "}
          {preview?.ok
            ? "Attach link"
            : preview
              ? "Save without preview"
              : "Attach link"}
        </button>
      </>
    )
  } else if (mode === "delete") {
    title = `Remove "${source?.original_filename || "source"}"?`
    subtitle = "This won't delete the underlying file from your disk — only the link to it from Sutra."
    body = (
      <div className="space-y-3">
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          Are you sure? If a goal was using this source the coach will flag it as a boundary change on your next turn.
        </p>
        {submitError && <p className="text-xs text-[var(--danger)]">{submitError}</p>}
      </div>
    )
    footer = (
      <>
        <button onClick={onClose} data-testid="source-delete-cancel" className="min-h-11 text-xs px-3 py-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors border border-[var(--border)] rounded">
          Cancel
        </button>
        <button
          data-testid="source-delete-confirm"
          onClick={submitDelete}
          className="flex items-center gap-1.5 min-h-11 text-xs px-3 py-3 rounded bg-[var(--danger)] text-[var(--bg-primary)] hover:opacity-90 transition-opacity"
        >
          <Trash2 className="w-3 h-3" /> Remove
        </button>
      </>
    )
  }

  const Icon = mode === "link" ? Link2 : mode === "delete" ? Trash2 : Paperclip

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={Icon}
      title={title}
      subtitle={subtitle}
      maxWidth={mode === "link" ? "max-w-lg" : "max-w-md"}
      testId={`source-action-dialog-${mode}`}
      footer={footer}
    >
      {body}
    </CenteredDialog>
  )
}
