import { useEffect, useState } from "react";
import { Link2, Loader2, ExternalLink, FileText, ShieldAlert, ClipboardPaste, Sparkles, CheckCircle2 } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import LinkAskPanel from "./LinkAskPanel";
import { api } from "../lib/api";

/**
 * LinkPreviewDialog — LLM link exploration (Iteration 11).
 *
 * Founder feedback: "not just fetching an excerpt from the link — the LLM
 * should be invoked and then the preview should show what the LLM will be
 * able to extract from it."
 *
 * Flow when a URL is pasted:
 *   1. checking  — preview metadata (title/desc/snippet) via
 *                  /api/sources/link/preview (unchanged, fast).
 *   2. extracted — if the page is readable, the coach is invoked via
 *                  /api/sources/link/extract to read the FULL document and
 *                  return a structured preview of what it can pull out
 *                  (summary, key points, extractable items, suggested
 *                  questions). Shown instead of the raw snippet.
 *   3. ask       — a to-and-fro chat (LinkAskPanel) grounded on the same
 *                  document streams via /api/sources/link/ask (SSE).
 *   4. gated     — private / sign-in-required / empty pages can't be read
 *                  server-side; offer paste. The pasted text becomes the
 *                  document the coach reads, and is stored as the excerpt
 *                  on attach so AskPlanner sees real content.
 *   5. attach    — POST /api/sources/link stores the URL + excerpt. When an
 *                  extract succeeded, the curated excerpt (summary + key
 *                  points + items) rides along as `excerpt` so the planner
 *                  reads the *chosen* document, not the raw fetch.
 *
 * Props:
 *   open     — controlled open state
 *   onClose  — close handler
 *   url      — the URL the user pasted
 *   goalContext — optional goal text ("staff-level at Stripe by March") the coach
 *              shapes extraction/asks around, so chips serve the goal, not the
 *              page talking about itself.
 *   existingSource — reopen mode: an already-attached link source. Skips the
 *              preview fetch, seeds the editor + ask panel from its stored
 *              `text_excerpt`, and lets the user edit & save (PATCH) instead
 *              of attach.
 *   onSaved — called after a successful PATCH in existing-source mode.
 *   onAttach — async (excerpt?: string) => void; the parent performs the
 *              actual POST /api/sources/link call. When a curated excerpt
 *              exists it is passed so the attach can store it.
 */
export default function LinkPreviewDialog({ open, onClose, url = "", onAttach, goalContext = "", existingSource = null, onSaved }) {
  const isExisting = !!existingSource;
  const [status, setStatus] = useState("idle"); // "idle" | "checking" | "ok" | "fail"
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  // LLM extraction pass: null (not started / n/a) | {status:'loading'} |
  // {status:'ok', extract} | {status:'error', message}
  const [analysis, setAnalysis] = useState(null);
  const [gated, setGated] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Existing-source (reopen) mode: no preview fetch — seed from the stored
    // excerpt so the user sees what the coach already read and can edit it.
    if (existingSource) {
      setStatus("ok");
      setError("");
      setAnalysis(null);
      setGated(false);
      setPasteError("");
      setBrowseOpen(false);
      setPastedText(existingSource.text_excerpt || "");
      let host = "";
      try {
        host = new URL(existingSource.url).host;
      } catch {
        /* keep empty */
      }
      setPreview({
        url: existingSource.url,
        host,
        title: existingSource.original_filename || existingSource.url,
      });
      return;
    }
    if (!url) return;
    let cancelled = false;
    setStatus("checking");
    setPreview(null);
    setError("");
    setAnalysis(null);
    setGated(false);
    setPastedText("");
    setPasteError("");
    setBrowseOpen(false);
    api
      .previewLink(url)
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        setStatus(data?.ok ? "ok" : "fail");
        if (!data?.ok) {
          const isGated =
            data?.status === 401 || data?.status === 403 ||
            /sign-in|private|requires/i.test(data?.error || "");
          setGated(isGated);
          if (!isGated) setError(data?.error || "Couldn't read that link.");
        } else if (!(data?.snippet || "").trim()) {
          // 200 but empty body — usually a client-rendered login shell.
          setGated(true);
        } else {
          runExtract({ url: data.final_url || url });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus("fail");
        setError(typeof e?.message === "string" ? e.message : "Couldn't fetch that link.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url, existingSource]);

  const runExtract = async (body) => {
    setAnalysis({ status: "loading" });
    try {
      const res = await api.extractLink({ ...body, goal: goalContext || undefined });
      if (body?.text && res?.url) setGated(false);
      if (res?.ok && res?.extract) {
        setAnalysis({ status: "ok", extract: res.extract });
      } else {
        setAnalysis({ status: "error", message: res?.error || "The coach couldn't read this page." });
      }
    } catch (e) {
      setAnalysis({ status: "error", message: typeof e?.message === "string" ? e.message : "Couldn't read that page." });
    }
  };

  const readPasted = () => {
    const t = pastedText.trim();
    if (!t) return;
    setGated(false);
    runExtract({ text: t });
  };

  // One-tap paste: reads the clipboard directly so mobile users don't have
  // to long-press → Paste (and desktop users don't need Cmd+A/Cmd+C first).
  const pasteFromClipboard = async () => {
    setPasteError("");
    setPasting(true);
    try {
      const text = await navigator.clipboard.readText();
      setPastedText(text?.trim() || "");
      if (!text?.trim()) {
        setPasteError("Your clipboard looks empty — copy the page in your browser first.");
      }
    } catch {
      setPasteError("The browser blocked clipboard access. Long-press the box and choose Paste instead.");
    } finally {
      setPasting(false);
    }
  };

  // The curated excerpt AskPlanner will read: extract summary + key points +
  // items, else the pasted text, else undefined (server fetch stands).
  const curatedExcerpt = () => {
    if (analysis?.status === "ok" && analysis.extract) {
      const { summary, key_points = [], extractable_items = [] } = analysis.extract;
      const lines = [summary, ...key_points, ...extractable_items].filter(Boolean);
      return lines.length ? lines.join("\n") : (pastedText.trim() || undefined);
    }
    if (gated && pastedText.trim()) return pastedText.trim();
    return pastedText.trim() || undefined;
  };

  const attach = async () => {
    if (attaching) return;
    setAttaching(true);
    try {
      await onAttach?.(curatedExcerpt());
      onClose?.();
    } catch (e) {
      setError(typeof e?.message === "string" ? e.message : "Couldn't attach that link.");
    } finally {
      setAttaching(false);
    }
  };

  // Existing-source mode: persist the edited excerpt. What's saved here is
  // exactly what AskPlanner reads next turn.
  const saveExisting = async () => {
    if (saving || !existingSource?.id) return;
    setSaving(true);
    setError("");
    try {
      await api.updateSource(existingSource.id, { text_excerpt: pastedText });
      onSaved?.();
      onClose?.();
    } catch (e) {
      setError(typeof e?.message === "string" ? e.message : "Couldn't save changes.");
    } finally {
      setSaving(false);
    }
  };

  // "Re-read with the coach" — re-run the extraction over the current excerpt
  // and replace the editor with the refreshed summary + points + items.
  const rereadExisting = async () => {
    const doc = pastedText.trim();
    if (!doc || analysis?.status === "loading") return;
    setAnalysis({ status: "loading" });
    try {
      const res = await api.extractLink({ text: doc, goal: goalContext || undefined });
      if (res?.ok && res.extract) {
        const { summary, key_points = [], extractable_items = [] } = res.extract;
        setPastedText([summary, ...key_points, ...extractable_items].filter(Boolean).join("\n"));
        setAnalysis({ status: "ok", extract: res.extract });
      } else {
        setAnalysis({ status: "error", message: res?.error || "The coach couldn't re-read this." });
      }
    } catch (e) {
      setAnalysis({ status: "error", message: typeof e?.message === "string" ? e.message : "Couldn't re-read this." });
    }
  };

  const suggestFromExtract = (a) =>
    (a?.status === "ok" && Array.isArray(a.extract?.suggested_questions)) ? a.extract.suggested_questions : [];
  const askText = gated ? pastedText : undefined;

  return (
    <CenteredDialog
      open={open}
      onClose={attaching ? undefined : onClose}
      icon={Link2}
      title="Add this link as a source?"
      subtitle={url}
      maxWidth="max-w-xl"
      testId="link-preview-dialog"
    >
      <div className="space-y-3" data-testid="link-preview-status">
        {status === "checking" && (
          <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" aria-hidden="true" />
            <span data-testid="link-preview-checking">Checking…</span>
          </div>
        )}

        {isExisting && (
          <div data-testid="link-preview-existing" className="space-y-3">
            <div className="rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <div className="flex items-start gap-2">
                <FileText className="w-4 h-4 text-[var(--accent)] shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {preview?.title || existingSource.url}
                  </div>
                  <div className="mt-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                    {preview?.host || "Link"}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">
                What the coach has from this page — editable
              </div>
              <textarea
                data-testid="source-excerpt-editor"
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                rows={7}
                aria-label="Source content"
                className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2.5 text-xs leading-relaxed text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] resize-y"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="source-reread"
                  onClick={rereadExisting}
                  disabled={!pastedText.trim() || analysis?.status === "loading"}
                  className="inline-flex items-center gap-1.5 min-h-11 px-3 text-xs border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] rounded transition-colors disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                >
                  {analysis?.status === "loading" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  Re-read with the coach
                </button>
              </div>
              {analysis?.status === "error" && (
                <p className="text-xs text-[var(--danger)]">{analysis.message}</p>
              )}
            </div>

            <LinkAskPanel url={existingSource.url} text={pastedText} goalContext={goalContext} />
            <p className="text-xs text-[var(--text-muted)]">
              Edit the content the coach keeps, or ask follow-ups — both change how this source is used
              for the goal.
            </p>
          </div>
        )}

        {!isExisting && status === "ok" && preview && (
          <div data-testid="link-preview-ok" className="space-y-2">
            <div className="rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3">
              <div className="flex items-start gap-2">
                <FileText className="w-4 h-4 text-[var(--accent)] shrink-0 mt-0.5" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                    {preview.title || preview.url || "Untitled"}
                  </div>
                  {preview.description && (
                    <p className="mt-1 text-xs text-[var(--text-secondary)] line-clamp-3">
                      {preview.description}
                    </p>
                  )}
                  <div className="mt-2 text-[10px] uppercase tracking-widest text-[var(--text-muted)]">
                    {preview.host || "Link"}
                  </div>
                </div>
              </div>
            </div>

            {analysis?.status === "loading" && (
              <div
                data-testid="link-preview-extracting"
                className="flex items-start gap-2 rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-xs text-[var(--text-secondary)]"
              >
                <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)] shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <div className="font-medium text-[var(--text-primary)]">The coach is reading this page…</div>
                  <div className="mt-0.5 text-[var(--text-muted)]">
                    It&apos;s pulling out what it can actually use — questions, topics, requirements.
                  </div>
                </div>
              </div>
            )}

            {analysis?.status === "ok" && (
              <div data-testid="link-preview-extract" className="space-y-2">
                <div className="rounded border border-[color-mix(in_srgb,var(--success)_35%,transparent)] bg-[color-mix(in_srgb,var(--success)_8%,transparent)] p-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-[var(--success)]">
                    <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                    What the coach will read
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-primary)]">
                    {analysis.extract?.summary}
                  </p>
                  {analysis.extract?.key_points?.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {analysis.extract.key_points.slice(0, 4).map((p, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
                          <span className="text-[var(--success)] mt-0.5" aria-hidden="true">·</span>
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {analysis.extract?.extractable_items?.length > 0 && (
                  <div className="rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">
                      It can extract
                    </div>
                    <ul className="mt-1.5 space-y-1">
                      {analysis.extract.extractable_items.map((item, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
                          <Sparkles className="w-3 h-3 text-[var(--accent)] shrink-0 mt-0.5" aria-hidden="true" />
                          <span className="min-w-0 flex-1">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <LinkAskPanel url={preview.final_url || preview.url} text={askText} suggestions={suggestFromExtract(analysis)} goalContext={goalContext} />
                <p className="text-xs text-[var(--text-muted)]">
                  Ask the coach about the page before attaching — the final answer can guide AskPlanner on this goal.
                </p>
              </div>
            )}

            {analysis?.status === "error" && (
              <div data-testid="link-preview-extract-error" className="space-y-2">
                <p className="text-xs text-[var(--text-secondary)]">
                  The coach couldn&apos;t read this page to preview it, but it&apos;s still attachable.
                </p>
                <p className="text-xs text-[var(--danger)] font-mono">{analysis.message}</p>
                {preview.snippet?.trim() ? (
                  <div className="max-h-36 overflow-y-auto rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-xs leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap">
                    {preview.snippet}
                  </div>
                ) : (
                  <p className="text-xs text-[var(--warning)]">
                    Paste the page content below so the coach can read it.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {!isExisting && gated && (
          <div data-testid="link-preview-gated" className="space-y-2">
            <div className="flex items-start gap-2 rounded border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-3">
              <ShieldAlert className="w-4 h-4 text-[var(--warning)] shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  This page needs your signed-in browser
                </div>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)] leading-relaxed">
                  This site won&apos;t let the coach in without a login. That&apos;s okay — copy the
                  page content from your browser and paste it here. The coach will read exactly
                  what you paste.
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  <ClipboardPaste className="w-3.5 h-3.5 text-[var(--warning)]" aria-hidden="true" />
                  <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)]">
                    Paste page content
                  </span>
                </div>
                <textarea
                  data-testid="link-preview-paste"
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                  rows={5}
                  placeholder="Select all (Cmd+A), copy, then paste the page here…"
                  aria-label="Paste page content"
                  className="mt-1.5 w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 py-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-y"
                />
                {pasteError && (
                  <p data-testid="link-preview-paste-error" className="mt-1.5 text-xs text-[var(--warning)]">
                    {pasteError}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                  <button
                    type="button"
                    data-testid="link-preview-paste-btn"
                    onClick={pasteFromClipboard}
                    disabled={pasting || analysis?.status === "loading"}
                    className="inline-flex items-center gap-1.5 min-h-11 px-3 text-xs font-medium bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)] rounded transition-colors disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  >
                    {pasting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <ClipboardPaste className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    {pasting ? "Pasting…" : "Paste"}
                  </button>
                  <button
                    type="button"
                    data-testid="link-preview-read-paste"
                    onClick={readPasted}
                    disabled={!pastedText.trim() || analysis?.status === "loading"}
                    className="inline-flex items-center gap-1.5 min-h-11 px-3 text-xs border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] rounded transition-colors disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                  >
                    {analysis?.status === "loading" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    Read pasted text
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {!isExisting && status === "fail" && !gated && (
          <div data-testid="link-preview-fail" className="space-y-2">
            <p className="text-sm text-[var(--text-secondary)]">
              We couldn&apos;t read this link. Some sites block bots, some need a login, some time out before the coach can ingest them.
            </p>
            {error && <p className="text-xs text-[var(--danger)] font-mono">{error}</p>}
            <p className="text-xs text-[var(--text-muted)]">
              You can attach the URL, but the coach will not have the page content. Paste or upload the relevant text instead of relying on an unreadable link.
            </p>
          </div>
        )}

        {!isExisting && (status === "ok" || gated) && (preview?.final_url || preview?.url || url) && (
          <div data-testid="link-preview-browse" className={browseOpen ? "space-y-2" : ""}>
            <button
              type="button"
              data-testid="link-preview-browse-toggle"
              onClick={() => setBrowseOpen((v) => !v)}
              aria-expanded={browseOpen}
              className="inline-flex items-center gap-1.5 min-h-11 px-3 text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              {browseOpen ? "Collapse inline preview" : "Browse the page in this box"}
            </button>

            {browseOpen && (
              <div className="space-y-2 rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2.5">
                <div className="flex items-center justify-between gap-2 px-1">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)] truncate">
                    {preview?.host || "Live page"}
                  </span>
                  <a
                    href={preview?.final_url || preview?.url || url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors min-h-6"
                  >
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    Open in new tab
                  </a>
                </div>

                {preview?.embeddable === false ? (
                  <div
                    data-testid="link-preview-not-embeddable"
                    className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)] leading-relaxed px-1"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-[var(--warning)] shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      This site doesn&apos;t allow being opened inside the box. Open it in a new tab,
                      select what you need, copy it, then {gated ? "paste it in the box" : "tap Paste"}.
                    </span>
                  </div>
                ) : (
                  <>
                    <iframe
                      data-testid="link-preview-browse-frame"
                      title={`Preview of ${preview?.host || url}`}
                      src={preview?.final_url || preview?.url || url}
                      className="w-full h-[300px] sm:h-[380px] rounded border border-[var(--border)] bg-white"
                      referrerPolicy="no-referrer"
                    />
                    <p className="text-[11px] text-[var(--text-muted)] leading-relaxed px-1">
                      Browse here — the page remembers your sign-in. Select the part that matters for
                      your goal, copy it (Cmd+C / right-click), then {gated ? "paste it in the box" : "tap Paste"}.
                    </p>
                  </>
                )}

                {!gated && (
                  <div className="space-y-1.5 px-1">
                    <textarea
                      data-testid="link-preview-paste"
                      value={pastedText}
                      onChange={(e) => setPastedText(e.target.value)}
                      rows={4}
                      placeholder="Copied text lands here — review it before reading."
                      aria-label="Pasted page content"
                      className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-3 py-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-y"
                    />
                    {pasteError && (
                      <p data-testid="link-preview-paste-error" className="text-xs text-[var(--warning)]">
                        {pasteError}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-testid="link-preview-paste-btn"
                        onClick={pasteFromClipboard}
                        disabled={pasting || analysis?.status === "loading"}
                        className="inline-flex items-center gap-1.5 min-h-11 px-3 text-xs font-medium bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)] rounded transition-colors disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                      >
                        {pasting ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <ClipboardPaste className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                        {pasting ? "Pasting…" : "Paste what I copied"}
                      </button>
                      <button
                        type="button"
                        data-testid="link-preview-read-paste"
                        onClick={readPasted}
                        disabled={!pastedText.trim() || analysis?.status === "loading"}
                        className="inline-flex items-center gap-1.5 min-h-11 px-3 text-xs border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] rounded transition-colors disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                      >
                        {analysis?.status === "loading" ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                        Read pasted text
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          {!isExisting && status === "ok" && preview?.url && (
            <a
              href={preview.url}
              target="_blank"
              rel="noreferrer noopener"
              className="min-h-11 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
              Open
            </a>
          )}
          <button
            type="button"
            data-testid="link-preview-cancel"
            onClick={onClose}
            disabled={attaching || saving}
            className="min-h-11 px-3 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          {isExisting ? (
            <button
              type="button"
              data-testid="source-save"
              onClick={saveExisting}
              disabled={saving}
              className="flex items-center gap-1.5 min-h-11 px-4 text-xs font-medium bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              {saving ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Saving…
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Save changes
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              data-testid="link-preview-attach"
              onClick={attach}
              disabled={attaching || status === "checking"}
              className="flex items-center gap-1.5 min-h-11 px-4 text-xs font-medium bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              {attaching ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Attaching…
                </>
              ) : (
                <>
                  <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                  {preview?.snippet?.trim() || analysis?.status === "ok" || pastedText.trim()
                    ? "Attach + use in plan"
                    : "Attach URL only"}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </CenteredDialog>
  );
}