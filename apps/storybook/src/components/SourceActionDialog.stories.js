import { fn } from "storybook/test";
import SourceActionDialog from "./SourceActionDialog";

export default {
  title: "Components/SourceActionDialog",
  component: SourceActionDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
    mode: "link",
    source: null,
    onUploadFile: fn(),
    onAddLink: fn(),
    onDeleteSource: fn(),
    goalId: "g1",
    goalTitle: "Switch into platform engineering",
  },
};

export const Default = {};
