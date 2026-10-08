import { fn } from "storybook/test";
import Header from "./Header";

export default {
  title: "Components/Header",
  component: Header,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    user: {
      user_id: "user_story01",
      name: "Devansh U. Agarwal",
      email: "dev@example.com",
      picture: undefined,
    },
    authLoading: false,
    onOpenChat: fn(),
    onOpenAbout: fn(),
    onSignIn: fn(),
    onLogout: fn(),
    devLoginAvailable: false,
    currentUserId: "user_story01",
  },
};

export const Default = {};

export const SignedOut = {
  args: {
    user: { user_id: null, name: "Guest", is_guest: true },
    currentUserId: null,
  },
};

export const SignedIn = {
  args: {
    user: {
      user_id: "user_story01",
      name: "Devansh U. Agarwal",
      email: "dev@example.com",
      picture: undefined,
    },
    authLoading: false,
    currentUserId: "user_story01",
  },
  // TODO: add "mobile profile (signed-in)" story once the drawer is
  // removed and replaced by GoalMenu + avatar profile menu.
};