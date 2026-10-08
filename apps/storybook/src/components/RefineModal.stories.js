import { fn } from "storybook/test";
import RefineModal from "./RefineModal";

export default {
  title: "Components/RefineModal",
  component: RefineModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    proposalTitle: "Build a running habit this quarter",
    proposalActionKey: "create_goal",
  },
};

export const Empty = {
  render: (args, { component }) => {
    return component({ ...args, open: false });
  },
};

export const WithThought = {
  render: (args, { component }) => {
    return component({
      ...args,
      thought: "Push the target date a month later, make the first step smaller",
    });
  },
};

export const Loading = {
  render: (args, { component }) => {
    return component({
      ...args,
      busy: true,
    });
  },
};