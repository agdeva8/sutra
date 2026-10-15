import { useEffect, useState } from "react";
import useInstallPrompt from "../hooks/use-install-prompt";
import { useGuideActive } from "../lib/guideActive";
import InstallPromptDialog from "./InstallPromptDialog";

/** The install sheet's own test id, so it never counts itself as "another dialog". */
const INSTALL_DIALOG_ID = "install-prompt-dialog";
const OTHER_DIALOG_SELECTOR = `[role="dialog"][aria-modal="true"]:not([data-testid="${INSTALL_DIALOG_ID}"])`;

/** True while any other modal dialog is on screen (the install sheet shares its z-index and stacked on top). */
function useOtherDialogOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => setOpen(!!document.querySelector(OTHER_DIALOG_SELECTOR));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return open;
}

/**
 * InstallPrompt — thin container: owns useInstallPrompt (the platform
 * detection + beforeinstallprompt plumbing) and drives InstallPromptDialog.
 * Mounted once in App.js so it's live on both routes.
 *
 * Rendered as null whenever the hook says nothing to show (already
 * installed, dismissed within 14 days, unsupported browser, or the
 * show-delay hasn't elapsed) — so it costs one listener on every load
 * and zero UI in the common case.
 */
export default function InstallPrompt() {
  const { open, platform, promptInstall, dismiss } = useInstallPrompt();
  const [installing, setInstalling] = useState(false);
  const guideActive = useGuideActive();
  const otherDialogOpen = useOtherDialogOpen();

  const handleInstall = async () => {
    setInstalling(true);
    try {
      await promptInstall();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <InstallPromptDialog
      open={open && platform !== "none" && !guideActive && !otherDialogOpen}
      platform={platform === "ios" ? "ios" : "chromium"}
      onClose={dismiss}
      onInstall={handleInstall}
      installing={installing}
    />
  );
}
