/**
 * Feature switches that choose between two implementations of the same screen.
 *
 * `USE_AGENT_INTAKE`: the Add Goal flow runs on agentv2's intake (`/goals/intake`)
 * instead of the older chat-based AddGoalDialog. The old dialog is kept in the
 * tree, so turning this off is the whole rollback.
 */
export const USE_AGENT_INTAKE = false;

/**
 * The goal card's PLAN button, which opens the goal's plan list. Hidden for now: the list drew generic
 * "Weekly Plan" / "Monthly Plan" rows without their focus, so it read as noise rather than a ladder.
 * The panel and its route stay in the tree — Today's target sections are the surface that carries the
 * plan until this is turned back on.
 */
export const SHOW_PLAN_LIST = false;

/**
 * Developer-only surfaces (the dev-login probe, the persona switcher, Settings > Developer).
 * Off in a production build, so none of their requests or UI ship to users; a deployment that really
 * wants them sets `REACT_APP_ENABLE_DEV_TOOLS=true` at build time.
 */
export const ENABLE_DEV_TOOLS =
  process.env.NODE_ENV !== "production" || process.env.REACT_APP_ENABLE_DEV_TOOLS === "true";
