import { fn } from "storybook/test";
import AboutModal from "./AboutModal";

export default {
  title: "Components/AboutModal",
  component: AboutModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
  },
};

export const Default = {};
