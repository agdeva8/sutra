import { useEffect, useState } from "react";
import { INSTALL_PLATFORM, useInstallPrompt } from "../lib/install";
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
 * InstallPrompt — thin container: drives InstallPromptDialog from the shared
 * install store (lib/install.js) — the platform detection and the held
 * `beforeinstallprompt` live there now, because the top-bar InstallButton reads
 * the same event. Mounted once in App.js so it's live on both routes.
 *
 * The InstallButton is the main way in; this automatic sheet is the gentle
 * nudge for someone who hasn't gone looking.
 *
 * Rendered as null whenever the store says nothing to show (already installed,
 * dismissed within a day, unsupported browser, or the show-delay hasn't
 * elapsed) — so it costs one listener on every load and zero UI in the common
 * case.
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
      open={open && platform !== INSTALL_PLATFORM.NONE && !guideActive && !otherDialogOpen}
      platform={platform === INSTALL_PLATFORM.IOS ? INSTALL_PLATFORM.IOS : INSTALL_PLATFORM.CHROMIUM}
      onClose={dismiss}
      onInstall={handleInstall}
      installing={installing}
    />
  );
}
