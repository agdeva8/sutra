import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/index.css";
import App from "@/App";
import { initDebug } from "@/lib/debug";

// Runs before the first render so the error ring buffer catches startup
// failures and eruda attaches when `?debug=1` is present (see lib/debug.js).
initDebug();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

// iOS Safari ignores `user-scalable=no`; its pinch arrives as gesture events, so stop them here
// (index.css `touch-action` covers the other browsers).
["gesturestart", "gesturechange"].forEach((type) => document.addEventListener(type, (e) => e.preventDefault(), { passive: false }));

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
