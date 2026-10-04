import Motivation from "./Motivation";

/**
 * Motivation is the "Curated for you" screen: a page frame around
 * MotivationCard, which fetches its own recommendations. With no goals
 * the card hides itself and the empty-state copy shows.
 */
export default {
  title: "Components/Motivation",
  component: Motivation,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    // MotivationCard fetches /api/motivation/recommend on mount. A 'hit'
    // cache stops it from polling for a background refresh.
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
            frame: "Pairs with your habit-building goal \u2014 start smaller than feels satisfying.",
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
      commitments: [
        { id: "c1", text: "Easy 5k before work", due: "2026-01-01", status: "open", goal_id: "g1" },
      ],
    },
  },
};

export const Default = {};

/** No goals yet → the card hides, the screen shows its empty-state copy. */
export const Empty = {
  args: { state: { goals: [], commitments: [] } },
};
