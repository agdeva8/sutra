import { useEffect, useState } from "react";
import { LogIn, Terminal } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import { API } from "../lib/api";
import Logo from "./Logo";

export default function SignInModal({ open, onClose, reason }) {
  const [devLoginAvailable, setDevLoginAvailable] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  // Probe the dev-login endpoint once when the modal opens; if the
  // server returns 200 the bypass is enabled for this environment
  // (gated on ALLOW_DEV_LOGIN=true), and we surface the button. If
  // 404, the button stays hidden — invisible to anyone who isn't
  // actively developing.
  useEffect(() => {
    if (!open) {
      setDevLoginAvailable(false);
      return;
    }
    let cancelled = false;
    fetch(`${API}/auth/dev-login?probe=1`, { method: "GET" })
      .then((res) => {
        if (!cancelled) setDevLoginAvailable(res.status === 200);
      })
      .catch(() => {
        if (!cancelled) setDevLoginAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const signIn = () => {
    // REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
    const redirectUrl = window.location.origin + "/";
    window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  const devSignIn = async () => {
    setSigningIn(true);
    try {
      const res = await fetch(`${API}/auth/dev-login?user_id=user_founder01&name=Dev%20User`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        setSigningIn(false);
        return;
      }
      // Cookie is set; full reload so the auth context re-resolves cleanly.
      window.location.reload();
    } catch {
      setSigningIn(false);
    }
  };

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      testId="signin-modal"
      title="Sign in to keep this"
      icon={LogIn}
      maxWidth="max-w-md"
      closeOnBackdrop={true}
    >
      <div className="px-2 py-1">
        <Logo className="w-9 h-9 text-[var(--accent)]" />
        <p className="text-sm leading-relaxed text-[var(--text-secondary)] mt-3">
          {reason || "You've been previewing Sutra. To save this goal, build your timeline, and have the coach remember you next week, sign in."}
          {" "}Nothing you did in preview is stored until you do.
        </p>
        <button
          data-testid="signin-google-button"
          onClick={signIn}
          className="mt-6 w-full flex items-center justify-center gap-3 bg-[var(--text-primary)] text-[var(--bg-primary)] px-5 py-3 font-medium text-sm hover:opacity-90 transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>
        <p className="mt-3 font-mono text-[11px] text-[var(--text-muted)] leading-relaxed">
          Your data is yours alone — encrypted, never sold or shared, and not even read by the team.
        </p>
        {devLoginAvailable && (
          <div className="mt-5 border-t border-[var(--border)] pt-5">
            <button
              data-testid="signin-dev-button"
              onClick={devSignIn}
              disabled={signingIn}
              className="min-h-11 w-full flex items-center justify-center gap-2 border border-dashed border-[var(--border-accent)] bg-[var(--bg-primary)] text-[var(--text-secondary)] px-5 py-3 font-mono text-[11px] uppercase tracking-widest hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
              {signingIn ? "Signing in…" : "Continue as Dev User (founders01)"}
            </button>
            <p className="mt-2 font-mono text-[10px] text-[var(--text-muted)] leading-relaxed">
              Local-only shortcut for building. Disabled in production — when ALLOW_DEV_LOGIN isn't set the button is hidden.
            </p>
          </div>
        )}
      </div>
    </CenteredDialog>
  );
}
