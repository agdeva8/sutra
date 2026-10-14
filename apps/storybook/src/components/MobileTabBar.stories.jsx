import MobileTabBar from "./MobileTabBar";

export default {
  title: "Components/MobileTabBar",
  component: MobileTabBar,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    viewport: { defaultViewport: "mobile1" },
  },
  args: { activeKey: "home" },
};

export const Overview = {};
export const Today = { args: { activeKey: "today" } };
/** A screen behind "More" lights the hamburger instead of a pinned tab. */
export const OverflowScreenActive = { args: { activeKey: "sources" } };
