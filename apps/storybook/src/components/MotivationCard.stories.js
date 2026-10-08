import { fn } from "storybook/test";
import MotivationCard from "./MotivationCard";
import { localDateKey } from "../lib/utils";

// The card only shows itself when something is overdue or a goal is active;
// an overdue MILESTONE is the case it was built for.
const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);

const state = {
  goals: [
    { id: "g1", title: "Switch into platform engineering", status: "active" },
    { id: "g2", title: "Run a marathon", status: "active" },
  ],
  milestones: [
    { id: "m1", title: "Rewrite the CV summary", target_date: localDateKey(yesterday), status: "open" },
  ],
};

// GET /api/motivation/recommend returns { items: [...] }.
const items = [
  {
    id: "rec_1",
    kind: "book",
    title: "Deep Work",
    author: "Cal Newport",
    duration: "6 min read",
    url: "https://calnewport.com/books/deep-work/",
    frame: "You've said the evening writing block keeps slipping — this is the shortest argument for defending it.",
  },
  {
    id: "rec_2",
    kind: "talk",
    title: "How to make hard choices",
    author: "Ruth Chang",
    duration: "14 min watch",
    url: "https://www.ted.com/talks/ruth_chang_how_to_make_hard_choices",
    frame: "Two goals are pulling at the same week. This reframes the trade-off as identity, not arithmetic.",
  },
  {
    id: "rec_3",
    kind: "article",
    title: "The plateau of latent potential",
    author: "James Clear",
    duration: "4 min read",
    url: "https://jamesclear.com/atomic-habits",
    frame: "The overdue item isn't proof the habit failed — it's the valley every habit crosses first.",
  },
];

export default {
  title: "Components/MotivationCard",
  component: MotivationCard,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    // Mock returns cache: 'hit' so the card doesn't enter the SWR
    // poll loop in Storybook (which would never converge on its
    // own). Use the `Refreshing` story below to see the in-flight
    // SWR state.
    api: { "motivation/recommend": { items, cache: "hit" } },
  },
  args: {
    state,
  },
};

export const Default = {};

// SWR in flight — the server has no cached picks yet and is searching
// in the background, so the card shows its "searching" line. Use the
// Default story to see the settled picks state.
export const Searching = {
  parameters: {
    api: {
      "motivation/recommend": {
        items: [],
        cache: "miss",
      },
    },
  },
};
