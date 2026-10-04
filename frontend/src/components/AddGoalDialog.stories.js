import { fn } from "storybook/test";
import AddGoalDialog from "./AddGoalDialog";

export default {
  title: "Components/AddGoalDialog",
  component: AddGoalDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    autoAnswer: true,
    grillMe: false,
    onUploadSource: fn(),
    onAddLink: fn(),
    onDeleteSource: fn(),
    onGoalConfirmed: fn(),
  },
};

export const Tiles = {};

// The former `ChatStep*` stories passed a `messages` prop the dialog never
// read (its chat state is internal) and used a `render` shim that called a
// non-existent `args.component`, so they threw on render. The chat + proposal
// + clarification surfaces are covered by the `ChatConsole` stories instead.
