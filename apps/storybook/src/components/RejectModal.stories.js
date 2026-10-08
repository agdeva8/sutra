import { fn } from "storybook/test";
import RejectModal from "./RejectModal";

export default {
  title: "Components/RejectModal",
  component: RejectModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    proposalTitle: "Ship side-project MVP in 2 months",
    proposalActionKey: "add_milestone",
  },
};

export const Empty = {
  render: (args, { component }) => {
    return component({ ...args, open: false });
  },
};

export const WithReason = {
  render: (args, { component }) => {
    return component({
      ...args,
      reason: "The target date is too soon for my current capacity",
    });
  },
};

export const SkipReason = {
  render: (args, { component }) => {
    return component({
      ...args,
      skipReason: true,
    });
  },
};