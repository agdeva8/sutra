import { useState } from "react";
import useInstallPrompt from "../hooks/use-install-prompt";
import { useGuideActive } from "../lib/guideActive";
import InstallPromptDialog from "./InstallPromptDialog";

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
      open={open && platform !== "none" && !guideActive}
      platform={platform === "ios" ? "ios" : "chromium"}
      onClose={dismiss}
      onInstall={handleInstall}
      installing={installing}
    />
  );
}
