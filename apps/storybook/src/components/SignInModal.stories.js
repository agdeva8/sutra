import { fn } from "storybook/test";
import SignInModal from "./SignInModal";

export default {
  title: "Components/SignInModal",
  component: SignInModal,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    // The dev-login probe is a bare GET; a 200 makes the modal reveal the
    // local-only shortcut, which is the fuller render.
    api: { "auth/dev-login": { ok: true } },
  },
  args: {
    open: true,
    onClose: fn(),
    reason: "",
  },
};

export const Default = {};
