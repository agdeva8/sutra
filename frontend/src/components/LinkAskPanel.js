import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Sparkles } from "lucide-react";
import { API } from "../lib/api";
import MarkdownMessage from "./MarkdownMessage";

/**
 * LinkAskPanel — to-and-fro Q&A about a fetched/pasted link document.
 *
 * Lives inside LinkPreviewDialog. Streams `/api/sources/link/ask` (SSE —
 * same `{type:"delta"|"done"|"error"}` wire format as /chat/stream) via
 * the same ReadableStream reader ChatModal uses, grounded on the document
 * the server resolved (url fetch server-side, or pasted text).
 *
 * Session-local: messages exist only for the life of the dialog. Attaching
 * the link is the only persist.
 *
 * Props:
 *   url   — the original URL (server re-fetches with the SSRF guard when
 *           text is absent)
 *   text  — pasted document text (gated pages); takes precedence over url
 *   suggestions — quick-prompt chips from the extract card; clicking one
 *           sends it
 *   disabled    — debug/loading gate (e.g. while the initial extract runs)
 */
const WIRE = { delta: "delta", done: "done", error: "error" };

export default function LinkAskPanel({ url = "", text = "", suggestions = [], disabled = false, goalContext = "" }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamError, setStreamError] = useState("");
  const listRef = useRef(null);
  const taRef = useRef(null);
  const streamIdRef = useRef(0);

  // Keep the newest message in view while streaming.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Auto-grow composer (mirrors ChatConsole).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    if (!input) {
      el.style.height = "40px";
      return;
    }
    el.style.height = "auto";
    const next = Math.min(200, Math.max(40, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [input]);

  const send = async (raw) => {
    const trimmed = typeof raw === "string" ? raw.trim() : input.trim();
    if (!trimmed || sending || disabled) return;
    setInput("");
    setStreamError("");
    const localId = `ask_user_${Date.now()}`;
    const streamId = `ask_stream_${++streamIdRef.current}`;
    setMessages((prev) => [
      ...prev,
      { id: localId, role: "user", content: trimmed },
      { id: streamId, role: "assistant", content: "", streaming: true },
    ]);
    setSending(true);

    const history = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content || "" }));

    try {
      const resp = await fetch(`${API}/sources/link/ask`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url || undefined,
          text: text || undefined,
          goal: goalContext || undefined,
          messages: [...history, { role: "user", content: trimmed }],
        }),
      });
      if (!resp.ok || !resp.body) throw new Error("stream failed");
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const handle = (data) => {
        if (data.type === WIRE.delta) {
          setMessages((prev) =>
            prev.map((m) => (m.id === streamId ? { ...m, content: m.content + data.content } : m)),
          );
        } else if (data.type === WIRE.done) {
          setMessages((prev) =>
            prev.map((m) => (m.id === streamId ? { ...m, streaming: false } : m)),
          );
        } else if (data.type === WIRE.error) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamId
                ? { ...m, streaming: false, content: m.content || "(no response)" }
                : m,
            ),
          );
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (raw.startsWith("data: ")) {
            try {
              handle(JSON.parse(raw.slice(6)));
            } catch {
              /* ignore malformed event */
            }
          }
        }
      }
    } catch {
      setStreamError("Connection dropped. Try asking again.");
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    } finally {
      setSending(false);
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    }
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div data-testid="link-ask-panel" className="flex flex-col min-h-0">
      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-[var(--text-muted)] mb-1.5">
        <Sparkles className="w-3 h-3 text-[var(--accent)]" aria-hidden="true" />
        Ask the coach about this page
      </div>

      <div
        ref={listRef}
        data-testid="link-ask-log"
        aria-live="polite"
        className="max-h-52 overflow-y-auto space-y-2 pr-1"
      >
        {messages.length === 0 && (
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            Ask the coach to extract what this page has <span className="font-medium">for your goal</span> —
            turn the useful bits into plan steps, checklists, or gaps you can act on.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            data-testid={`link-ask-msg-${m.role}`}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                m.role === "user"
                  ? "whitespace-pre-wrap bg-[var(--accent)] text-[var(--bg-primary)]"
                  : "bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)]"
              }`}
            >
              {m.role === "user" ? m.content : <MarkdownMessage content={m.content} />}
              {m.streaming && (
                <span className="inline-block w-1.5 h-3.5 align-middle bg-[var(--accent)] animate-pulse ml-0.5" aria-hidden="true" />
              )}
            </div>
          </div>
        ))}
        {streamError && (
          <p data-testid="link-ask-error" className="text-xs text-[var(--danger)]">
            {streamError}
          </p>
        )}
      </div>

      {suggestions.length > 0 && !sending && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {suggestions.slice(0, 3).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => send(s)}
              className="max-w-full truncate px-2.5 py-1.5 text-[11px] rounded-full border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 mt-2">
        <textarea
          ref={taRef}
          data-testid="link-ask-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          disabled={disabled}
          placeholder="Ask the coach…"
          aria-label="Ask the coach about this page"
          className="flex-1 min-h-10 max-h-50 resize-none bg-[var(--bg-primary)] border border-[var(--border)] rounded px-3 pt-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] disabled:opacity-40"
        />
        <button
          type="button"
          data-testid="link-ask-send"
          onClick={() => send()}
          disabled={disabled || sending || !input.trim()}
          aria-label="Send question"
          className="h-10 w-10 shrink-0 flex items-center justify-center bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-30 hover:opacity-90 transition-opacity rounded"
        >
          {sending ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowUp className="w-4 h-4" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}