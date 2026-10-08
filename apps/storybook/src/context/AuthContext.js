import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import { getCachedUser, setCachedUser, clearCachedUser, isDifferentUser } from "../lib/auth-cache";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const isOAuthCallback =
    typeof window !== "undefined" && window.location.hash?.includes("session_id=");

  // Synchronous read from cache on mount: unblocks returning users immediately
  const [user, setUser] = useState(() => {
    if (isOAuthCallback) return null;
    return getCachedUser();
  });

  const [loading, setLoading] = useState(() => {
    if (isOAuthCallback) return false;
    return !getCachedUser();
  });

  const setAndCacheUser = useCallback((nextUser) => {
    setUser(nextUser);
    if (nextUser) {
      setCachedUser(nextUser);
    } else {
      clearCachedUser();
    }
  }, []);

  const checkAuth = useCallback(async () => {
    const cached = getCachedUser();

    if (cached) {
      // 1. Cached user present:
      // Fire api.me() in background.
      let meUser = null;
      try {
        meUser = await api.me();
      } catch {
        meUser = null;
      }

      if (meUser) {
        if (isDifferentUser(cached, meUser)) {
          setAndCacheUser(meUser);
        } else {
          setCachedUser(meUser);
        }
        return;
      }

      // If me returns null/401 -> fall through to step 2 (guest creation in background)
      try {
        const { user: guest } = await api.guest();
        setAndCacheUser(guest);
      } catch (e) {
        console.error("Guest session creation failed:", e);
        setAndCacheUser(null);
      }
    } else {
      // 2. No cache: probe me first, then guest
      let meUser = null;
      try {
        meUser = await api.me();
      } catch {
        meUser = null;
      }

      if (meUser) {
        setAndCacheUser(meUser);
        setLoading(false);
        return;
      }

      try {
        const { user: guest } = await api.guest();
        setAndCacheUser(guest);
      } catch (e) {
        console.error("Guest session creation failed:", e);
        setAndCacheUser(null);
      } finally {
        setLoading(false);
      }
    }
  }, [setAndCacheUser]);

  useEffect(() => {
    // CRITICAL: If returning from OAuth callback, skip the /me check.
    // AuthCallback will exchange the session_id and establish the session first.
    if (window.location.hash?.includes("session_id=")) {
      setLoading(false);
      return;
    }
    checkAuth();
  }, [checkAuth]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {}
    setAndCacheUser(null);
  }, [setAndCacheUser]);

  return (
    <AuthContext.Provider
      value={{
        user,
        setUser: setAndCacheUser,
        loading,
        checkAuth,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
