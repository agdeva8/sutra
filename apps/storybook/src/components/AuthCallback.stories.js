import { useLayoutEffect } from "react";
import AuthCallback from "./AuthCallback";
import { AuthProvider } from "../context/AuthContext";

/**
 * AuthCallback is a transient screen: it reads `session_id` out of the URL
 * hash, exchanges it for a session, then navigates away. Left alone it
 * would bounce straight off the canvas, so the harness stamps the hash
 * just before mount (layout effects fire before the component's own
 * effects) and pins the exchange in flight — the story then sits on the
 * screen a real user actually sees while waiting.
 */
function WithSessionHash({ children }) {
  useLayoutEffect(() => {
    const previous = window.location.href;
    window.history.replaceState(null, "", "#session_id=storybook-session");
    return () => window.history.replaceState(null, "", previous);
  }, []);
  return children;
}

export default {
  title: "Components/AuthCallback",
  component: AuthCallback,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    // Never settles → the component stays on "establishing session".
    api: { "auth/session": () => new Promise(() => {}) },
  },
  decorators: [
    (Story) => (
      <AuthProvider>
        <WithSessionHash>
          <Story />
        </WithSessionHash>
      </AuthProvider>
    ),
  ],
};

export const Default = {};
