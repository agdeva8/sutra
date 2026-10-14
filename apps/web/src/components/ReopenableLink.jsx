import { useState } from "react";
import LinkPreviewDialog from "./LinkPreviewDialog";
import { api } from "../lib/api";

/**
 * Whether a source is a link the coach read, so clicking it should reopen what it understood.
 * Locally added sources (before the server list is refreshed) may carry only a url.
 */
export function isLinkSource(source) {
  return source?.kind === "link" || (!source?.kind && /^https?:\/\//i.test(source?.url || ""));
}

/**
 * Click a link source anywhere and get the same dialog the first paste opens: the page, what the
 * coach read from it, and the edit and ask tools, so its reading can be corrected.
 *
 * Usage: `const { open, dialog } = useReopenLink(goalContext)`; call `open(source)` on click and
 * render `{dialog}` once.
 */
export function useReopenLink(goalContext = "") {
  const [source, setSource] = useState(null);

  const open = (s) => {
    if (!isLinkSource(s)) return false;
    setSource(s);
    // The list rows carry no text; load the full source so the dialog can show what was read.
    api.getSource(s.id).then(setSource).catch(() => {});
    return true;
  };

  const dialog = (
    <LinkPreviewDialog
      open={!!source}
      existingSource={source}
      goalContext={goalContext}
      onClose={() => setSource(null)}
      onSaved={() => setSource(null)}
    />
  );
  return { open, dialog };
}
