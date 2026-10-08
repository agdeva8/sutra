import { fn } from "storybook/test";
import FocusedTaskChatDialog from "./FocusedTaskChatDialog";

export default {
  title: "Components/FocusedTaskChatDialog",
  component: FocusedTaskChatDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
    title: "Ship the v2 landing page",
    subtitle: "Focus on this task. The chat below starts fresh and resets when you close it.",
    prefillMessage: "",
    user: { user_id: "user_story01", name: "Devansh" },
    isGuest: false,
    autoAnswer: true,
    grillMe: false,
    setAutoAnswer: fn(),
    setGrillMe: fn(),
    onStateChange: fn(),
    onAction: fn(),
    onUploadFile: fn(),
    onAddLink: fn(),
    onOpenSignIn: fn(),
    scope: "goal",
    refId: "g1",
    kind: null,
    helperText: "",
  },
};

export const Default = {};
