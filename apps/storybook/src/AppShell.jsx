/**
 * A router-agnostic mirror of `src/App.js`, for Storybook.
 *
 * Why this exists: `<App/>` renders a `BrowserRouter`, and its
 * `<Route path="*" element={<Navigate to="/" replace/>}/>` rewrites the URL
 * whenever the path doesn't match. Inside Storybook's iframe the path is
 * `/iframe.html`, so that catch-all navigates the iframe itself out of the
 * canvas and the story renders blank. A router you can seed is the only way to
 * show a real screen inside an iframe.
 *
 * It mirrors App.js's composition exactly — same providers, same two routes,
 * same components — and differs in one place: `MemoryRouter` seeded with
 * `initialPath` instead of `BrowserRouter`.
 *
 * The dev server (`pnpm dev`) does NOT use this file. It renders the real
 * `<App/>` through `InteractiveApp`, so it stays byte-faithful to the main
 * worktree. Use the dev server when a bug's URL matters; use these stories to
 * isolate one screen.
 */
import { useState, useEffect } from "react";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";

import { AuthProvider } from "@/context/AuthContext";
import InstallPrompt from "@/components/InstallPrompt";
import Coach from "@/pages/Coach";
import Settings from "@/pages/Settings";
// App.js imports this too — it carries `.App { min-height: 100vh; }`, which the
// screens depend on for full-height layout.
import "@/App.css";

// Mirrors App.js's ToasterBridge: the theme follows the `light` class on
// <html>, which Coach.js and Settings.jsx toggle.
function ToasterBridge() {
  const [theme, setTheme] = useState(() =>
    document.documentElement.classList.contains("light") ? "light" : "dark",
  );
  useEffect(() => {
    const mo = new MutationObserver(() => {
      setTheme(document.documentElement.classList.contains("light") ? "light" : "dark");
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      toastOptions={{
        style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12px" },
      }}
    />
  );
}

// One client per mount, matching main.jsx's defaults.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } },
});

export default function AppShell({ initialPath = "/" }) {
  return (
    // Same root element and class as App.js, so the screen gets the app's own
    // root styling rather than Storybook's canvas.
    <div className="App">
      <QueryClientProvider client={queryClient}>
        {/* `key` forces a remount when the story changes path, so the seeded
            entry actually takes effect. */}
        <MemoryRouter initialEntries={[initialPath]} key={initialPath}>
          <AuthProvider>
            <Routes>
              <Route path="/" element={<Coach />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            <InstallPrompt />
          </AuthProvider>
          <ToasterBridge />
        </MemoryRouter>
      </QueryClientProvider>
    </div>
  );
}
