/**
 * Feature switches that choose between two implementations of the same screen.
 *
 * `USE_AGENT_INTAKE`: the Add Goal flow runs on agentv2's intake (`/goals/intake`)
 * instead of the older chat-based AddGoalDialog. The old dialog is kept in the
 * tree, so turning this off is the whole rollback.
 */
export const USE_AGENT_INTAKE = true;
