import { fn } from "storybook/test";
import ChatModal from "./ChatModal";

// GET /api/chat/history returns the message array itself — ChatModal hands
// it straight to ChatConsole.
const history = [
  { id: "msg_1", role: "user", content: "What's blocking the marathon goal?", proposals: [] },
  {
    id: "msg_2",
    role: "assistant",
    content: "Nothing structural — you're just double-booking Tuesdays. Want me to move the long run?",
    proposals: [],
  },
];

export default {
  title: "Components/ChatModal",
  component: ChatModal,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: { "chat/history": history },
  },
  args: {
    open: true,
    onClose: fn(),
    user: { user_id: "user_story01", name: "Devansh", email: "dev@example.com" },
    setUser: fn(),
    autoAnswer: false,
    setAutoAnswer: fn(),
    grillMe: false,
    setGrillMe: fn(),
    onStateChange: fn(),
    onAction: fn(),
    onUploadFile: fn(),
    onAddLink: fn(),
    onOpenSignIn: fn(),
    isGuest: false,
    prefillMessage: "",
    scope: null,
    refId: null,
    kind: null,
    title: "",
    helperText: "",
  },
};

export const Default = {};
