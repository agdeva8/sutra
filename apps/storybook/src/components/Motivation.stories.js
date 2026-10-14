import Motivation from "./Motivation";

/**
 * Motivation is the "Curated for you" screen. The feature has not shipped, so
 * what it renders today is the coming-soon card — see `CURATED_IS_COMING_SOON`
 * in Motivation.jsx.
 *
 * The `api` fixture below is kept wired to the recommend route even though the
 * coming-soon branch never fetches: it is what the screen reads the moment that
 * flag flips, and it doubles as the fixtures behind Components/MotivationCard.
 */
export default {
  title: "Components/Motivation",
  component: Motivation,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: {
      "motivation/recommend": {
        cache: "hit",
        items: [
          {
            id: "m1",
            kind: "book",
            title: "Atomic Habits",
            author: "James Clear",
            duration: "12 min read",
            url: "https://example.com/atomic-habits",
            frame: "Pairs with your habit-building goal — start smaller than feels satisfying.",
          },
          {
            id: "m2",
            kind: "video",
            title: "How to plan a marathon block",
            author: "Some Coach",
            duration: "18 min watch",
            url: "https://example.com/marathon",
            frame: "Directly relevant now that your long runs are slipping.",
          },
        ],
      },
    },
  },
  args: {
    state: {
      goals: [{ id: "g1", title: "Run a marathon", status: "active" }],
      milestones: [
        { id: "m1", title: "Easy 5k before work", target_date: "2026-01-01", status: "open", goal_id: "g1" },
      ],
    },
  },
};

/** Today's shipped state of the screen: the coming-soon card. */
export const ComingSoon = {};
