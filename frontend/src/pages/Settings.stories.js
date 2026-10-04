import { expect } from "storybook/test";
import Settings from "./Settings";
import { AuthProvider } from "../context/AuthContext";

/**
 * Settings is the `/settings` route: a segmented control over Coach
 * (model), Preferences (text size), Account (session), and Audit tabs,
 * with a hidden Developer tab behind debug mode. It reads the user from
 * AuthContext, so stories wrap in AuthProvider with auth + model
 * endpoints stubbed.
 */
export default {
  title: "Components/Settings",
  component: Settings,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: {
      "auth/me": {
        user_id: "user_story01",
        name: "Devansh U. Agarwal",
        email: "dev@example.com",
        model_provider: "gemini",
      },
      "auth/guest": { user: { user_id: null, name: "Guest", is_guest: true } },
      "preferences/models": {
        models: [
          { value: "gemini", label: "Gemini", hint: "2.5 Pro" },
          { value: "claude", label: "Claude", hint: "Sonnet 4" },
          { value: "openai", label: "OpenAI", hint: "GPT-4o" },
        ],
      },
    },
  },
  decorators: [
    (Story) => (
      <AuthProvider>
        <Story />
      </AuthProvider>
    ),
  ],
};

/** Coach tab (default) — the model picker with the active provider marked. */
export const Default = {
  play: async ({ canvas }) => {
    expect(canvas.getByText("Model")).toBeInTheDocument();
    expect(canvas.getByRole("group", { name: "Model provider" })).toBeInTheDocument();
  },
};

/** Preferences tab — the text-size radiogroup. */
export const Preferences = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("tab", { name: "Preferences" }));
    expect(canvas.getByTestId("text-size-options")).toBeInTheDocument();
  },
};

/** Account tab — the session block. */
export const Account = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("tab", { name: "Account" }));
    expect(canvas.getByText("Session")).toBeInTheDocument();
  },
};
