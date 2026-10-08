import WelcomeToast from "./WelcomeToast";
import { localDateKey } from "../lib/utils";

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localDateKey(d);
};

const state = {
  goals: [
    { id: "g1", title: "Run a marathon", status: "active" },
    { id: "g2", title: "Ship the v2 landing page", status: "active" },
  ],
  milestones: [
    { id: "m1", title: "Easy 5k before work", status: "open", target_date: day(0), goal_title: "Run a marathon" },
    { id: "m2", title: "Rewrite the CV summary", status: "open", target_date: day(0), goal_title: "Ship the v2 landing page" },
    { id: "m3", title: "Order new running socks", status: "open", target_date: day(0), goal_title: "Run a marathon" },
  ],
};

export default {
  title: "Components/WelcomeToast",
  component: WelcomeToast,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => {
      // The greeting is once-per-day, guarded by localStorage — clear the
      // sentinel so every story mount actually fires it.
      try {
        localStorage.removeItem("gc_welcome_date");
      } catch {
        /* storage blocked — falls through to the toast anyway */
      }
      return <Story />;
    },
  ],
  args: {
    user: { user_id: "user_story01", name: "Devansh Agarwal" },
    state,
    signedIn: true,
  },
};

export const Default = {};
