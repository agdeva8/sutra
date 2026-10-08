import { fn } from "storybook/test";
import ToolConfirmationPrompt from "./ToolConfirmationPrompt";

export default {
  title: "Components/ToolConfirmationPrompt",
  component: ToolConfirmationPrompt,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    proposal: {
      id: "prop_001",
      action: "create_goal",
      args: {
        title: "Build a running habit this quarter",
        horizon: "weekly",
        why: "Want to start running regularly",
        first_action: "Start with a 10-minute jog",
        target_date: "2026-12-01",
      },
      status: "pending",
    },
    onConfirm: fn(),
    onReject: fn(),
    onOpenRefine: fn(),
    onOpenReject: fn(),
    busy: false,
  },
};

export const Default = {};

export const WithConfirmButton = {
  render: (args, { component }) => {
    return component({
      ...args,
      proposal: {
        ...args.proposal,
        status: "confirmed",
      },
    });
  },
};

export const WithRefineClick = {
  render: (args, { component }) => {
    // Simulate clicking the Refine button — this should open a
    // RefineModal instead of an inline textarea.
    const { onOpenRefine } = args;
    if (onOpenRefine) {
      onOpenRefine(args.proposal);
    }
    return component({ ...args });
  },
};

export const WithRejectClick = {
  render: (args, { component }) => {
    const { onOpenReject } = args;
    if (onOpenReject) {
      onOpenReject(args.proposal);
    }
    return component({ ...args });
  },
};