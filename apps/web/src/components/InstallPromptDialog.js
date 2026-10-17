import { Download, Share, Plus, Home, MessageCircle, CalendarCheck, HardDriveDownload, MoreVertical } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import { INSTALL_PLATFORM } from "../lib/install";

/**
 * InstallPromptDialog — "Add Sutra to your device" sheet.
 *
 * Presentational only: the platform decision (Chromium auto-install, Android's
 * overflow menu, iOS's Share sheet) comes in as a prop from whoever owns the
 * install store (lib/install.js). Keeping it dumb makes every state
 * story-testable without faking `beforeinstallprompt`.
 *
 * Props:
 *   open       — controlled visibility
 *   platform   — INSTALL_PLATFORM.CHROMIUM (Install button calls onInstall) |
 *                INSTALL_PLATFORM.ANDROID (the ⋮ menu steps) |
 *                INSTALL_PLATFORM.IOS (manual Share → Add to Home Screen steps)
 *   onClose    — close without installing (also Esc / backdrop)
 *   onInstall  — async () => outcome  (Chromium only; called on button tap)
 *   installing — true while the native prompt is open (disables the button)
 *
 * Only Chromium gets an install button — the event doesn't exist on the other
 * two, so we teach the gesture instead of showing a button that can't work.
 */
export default function InstallPromptDialog({
  open,
  platform = INSTALL_PLATFORM.CHROMIUM,
  onClose,
  onInstall,
  installing = false,
}) {
  if (!open) return null;

  const benefits = [
    { icon: MessageCircle, text: "Opens straight to your coach — one tap, no browser chrome." },
    { icon: CalendarCheck, text: "Your goals, Today tab and timeline, full screen." },
    { icon: HardDriveDownload, text: "Lives on your home screen like any other app." },
  ];

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={Download}
      title="Install Sutra"
      subtitle={
        platform === INSTALL_PLATFORM.IOS
          ? "Add Sutra to your Home Screen so it opens like a real app."
          : platform === INSTALL_PLATFORM.ANDROID
            ? "Chrome installs Sutra from its menu — here's where."
            : "Put Sutra on your device — it opens in its own window, no address bar."
      }
      maxWidth="max-w-md"
      testId="install-prompt-dialog"
      footer={
        platform === INSTALL_PLATFORM.CHROMIUM ? (
          <>
            <button
              onClick={onClose}
              data-testid="install-prompt-dismiss"
              className="min-h-11 flex items-center gap-1.5 text-xs px-3 py-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors border border-[var(--border)] rounded"
            >
              Not now
            </button>
            <button
              onClick={onInstall}
              disabled={installing}
              data-testid="install-prompt-install"
              className="min-h-11 flex items-center gap-1.5 text-xs px-3 py-3 rounded bg-[var(--accent)] text-[var(--bg-primary)] hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-wait"
            >
              <Download className="w-3 h-3" /> {installing ? "Opening installer…" : "Install"}
            </button>
          </>
        ) : (
          <button
            onClick={onClose}
            data-testid="install-prompt-dismiss"
            className="min-h-11 flex items-center gap-1.5 text-xs px-3 py-3 rounded bg-[var(--accent)] text-[var(--bg-primary)] hover:opacity-90 transition-opacity"
          >
            Got it
          </button>
        )
      }
    >
      {platform === INSTALL_PLATFORM.CHROMIUM ? (
        <ul data-testid="install-prompt-benefits" className="space-y-2.5">
          {benefits.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-2.5 text-sm text-[var(--text-secondary)] leading-relaxed">
              <Icon className="w-4 h-4 text-[var(--accent)] mt-0.5 shrink-0" aria-hidden="true" />
              {text}
            </li>
          ))}
        </ul>
      ) : platform === INSTALL_PLATFORM.ANDROID ? (
        <div data-testid="install-prompt-android-steps" className="space-y-3">
          <ol className="space-y-2.5 text-sm text-[var(--text-secondary)] leading-relaxed">
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 shrink-0 rounded-full border border-[var(--border-accent)] text-[var(--accent)] flex items-center justify-center text-[10px] font-semibold mt-0.5">1</span>
              <span>
                Tap the <MoreVertical className="inline w-3.5 h-3.5 mx-0.5 -mt-0.5 align-middle text-[var(--accent)]" aria-hidden="true" /> <strong className="text-[var(--text-primary)] font-medium">menu</strong> in Chrome&apos;s toolbar.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 shrink-0 rounded-full border border-[var(--border-accent)] text-[var(--accent)] flex items-center justify-center text-[10px] font-semibold mt-0.5">2</span>
              <span>
                Choose <Download className="inline w-3.5 h-3.5 mx-0.5 -mt-0.5 align-middle text-[var(--accent)]" aria-hidden="true" /> <strong className="text-[var(--text-primary)] font-medium">Install app</strong> — or <strong className="text-[var(--text-primary)] font-medium">Add to Home screen</strong> if that&apos;s the entry you see.
              </span>
            </li>
          </ol>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed border-t border-[var(--border)] pt-3">
            Chrome offers its one-tap install once you&apos;ve spent a little longer here — this way works now.
          </p>
        </div>
      ) : (
        <div data-testid="install-prompt-ios-steps" className="space-y-3">
          <ol className="space-y-2.5 text-sm text-[var(--text-secondary)] leading-relaxed">
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 shrink-0 rounded-full border border-[var(--border-accent)] text-[var(--accent)] flex items-center justify-center text-[10px] font-semibold mt-0.5">1</span>
              <span>
                Tap the <Share className="inline w-3.5 h-3.5 mx-0.5 -mt-0.5 align-middle text-[var(--accent)]" aria-hidden="true" /> <strong className="text-[var(--text-primary)] font-medium">Share</strong> button in your browser&apos;s toolbar.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 shrink-0 rounded-full border border-[var(--border-accent)] text-[var(--accent)] flex items-center justify-center text-[10px] font-semibold mt-0.5">2</span>
              <span>
                Scroll and choose <Plus className="inline w-3.5 h-3.5 mx-0.5 -mt-0.5 align-middle text-[var(--accent)]" aria-hidden="true" /> <strong className="text-[var(--text-primary)] font-medium">Add to Home Screen</strong>.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="w-5 h-5 shrink-0 rounded-full border border-[var(--border-accent)] text-[var(--accent)] flex items-center justify-center text-[10px] font-semibold mt-0.5">3</span>
              <span>
                Tap <Home className="inline w-3.5 h-3.5 mx-0.5 -mt-0.5 align-middle text-[var(--accent)]" aria-hidden="true" /> <strong className="text-[var(--text-primary)] font-medium">Add</strong> — Sutra appears on your home screen.
              </span>
            </li>
          </ol>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed border-t border-[var(--border)] pt-3">
            Add to Home Screen lives in the Share sheet — Safari always has it, and so do Chrome and Edge on iOS 16.4+.
          </p>
        </div>
      )}
    </CenteredDialog>
  );
}
