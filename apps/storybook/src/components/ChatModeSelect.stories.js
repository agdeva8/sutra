import { fn } from "storybook/test";
import ChatModeSelect from "./ChatModeSelect";

export default {
  title: "Components/ChatModeSelect",
  component: ChatModeSelect,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    autoAnswer: false,
    grillMe: false,
    setAutoAnswer: fn(),
    setGrillMe: fn(),
  },
  // The dropdown opens `bottom-full` (above its trigger). For the Open
  // story to render the menu inside the iframe, push the trigger down
  // from the top so there's room above it.
  decorators: [
    (Story) => (
      <div className="p-6 pt-32 max-w-sm">
        <Story />
      </div>
    ),
  ],
};

export const Default = {};

export const AutoAnswering = {
  args: { autoAnswer: true, grillMe: false },
};

export const GrillMe = {
  args: { autoAnswer: false, grillMe: true },
};

// Iteration 9 — the actual dropdown menu, opened. Storybook stories
// previously only showed the closed trigger — the menu itself (the 3
// options, descriptions, selected "on" marker) was invisible to a
// reviewer walking the gallery. initialOpen is a no-op in the running
// product (always false); it exists purely so stories can render the
// menu without needing a click interaction.
export const Open = {
  args: { initialOpen: true },
};
