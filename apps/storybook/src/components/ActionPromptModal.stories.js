import { fn } from "storybook/test";
import ActionPromptModal from "./ActionPromptModal";

export default {
  title: "Components/ActionPromptModal",
  component: ActionPromptModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    action: { type: "edit", goalTitle: "Ship the v2 landing page" },
    onClose: fn(),
    onSend: fn(),
  },
};

export const Default = {};

export const DropGoal = {
  args: {
    action: { type: "drop", goalTitle: "Learn watercolour painting" },
  },
};
