import { fn } from "storybook/test";
import PersonaMenu from "./PersonaMenu";

// GET /api/auth/personas returns { personas: [...] }; it only fires once the
// dropdown is opened.
const personas = [
  {
    user_id: "user_guest_a1b2c3d4e5f6",
    name: "Devansh",
    created_at: "2026-09-01T10:00:00Z",
  },
  {
    user_id: "user_story01",
    name: "Sofia (writing persona)",
    created_at: "2026-09-14T17:30:00Z",
    persona_key: "sofia",
  },
];

export default {
  title: "Components/PersonaMenu",
  component: PersonaMenu,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: { "auth/personas": { personas } },
  },
  args: {
    currentName: "Devansh",
    currentUserId: "user_guest_a1b2c3d4e5f6",
  },
};

export const Default = {};

// Iteration 9 — the dropdown opened. The Default story only shows the
// trigger button — the actual list of personas (rows, rename pencil,
// "new persona" affordance, sign-out row) was invisible to a reviewer
// walking the gallery. `initialOpen` is a no-op in the running product
// (always false); it exists so Storybook can render the menu without
// a click interaction.
export const Open = {
  args: { initialOpen: true },
};
