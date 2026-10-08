import { fn } from "storybook/test";
import DevDiagnostics from "./DevDiagnostics";

// Debug-mode-only surface (Settings → Developer). It reads live browser
// APIs (navigator, caches, serviceWorker), so the story renders against
// whatever the Storybook browser reports — that's the point: it shows the
// real diagnostic values.
export default {
  title: "Components/DevDiagnostics",
  component: DevDiagnostics,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    user: { email: "founder@example.com", is_guest: false },
    onDisable: fn(),
  },
};

/** Signed-in user, empty log. */
export const Default = {};

/** Guest session — the Session row should read "guest". */
export const Guest = {
  args: { user: { is_guest: true } },
};
