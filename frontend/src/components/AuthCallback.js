import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import Logo from "./Logo";

export default function AuthCallback() {
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const hasProcessed = useRef(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (hasProcessed.current) return;
    hasProcessed.current = true;

    const hash = window.location.hash || "";
    const match = hash.match(/session_id=([^&]+)/);
    const sessionId = match ? decodeURIComponent(match[1]) : null;

    if (!sessionId) {
      navigate("/", { replace: true });
      return;
    }

    (async () => {
      try {
        const { user } = await api.session(sessionId);
        setUser(user);
        window.history.replaceState(null, "", window.location.pathname);
        navigate("/", { replace: true, state: { user } });
      } catch (e) {
        setError(e.message);
      }
    })();
  }, [navigate, setUser]);

  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-[var(--bg-primary)]" data-testid="auth-callback">
      <div className="text-center flex flex-col items-center gap-4">
        <Logo className="w-10 h-10 text-[var(--accent)]" />
        {!error && (
          <div
            aria-hidden="true"
            className="h-4 w-4 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin"
          />
        )}
        <div className="font-mono text-xs uppercase tracking-widest text-[var(--text-muted)]">
          {error ? "auth failed" : "establishing session"}
        </div>
        {error && <div className="mt-1 text-sm text-[var(--danger)] max-w-xs">{error}</div>}
      </div>
    </div>
  );
}
