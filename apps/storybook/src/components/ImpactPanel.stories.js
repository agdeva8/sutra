import { expect } from "storybook/test";
import ImpactPanel from "./ImpactPanel";

export default {
  title: "Components/ImpactPanel",
  component: ImpactPanel,
  tags: ["autodocs"],
  args: {
    impact: {
      over_commitment: {
        from: "18 h/week",
        to: "23 h/week",
        reason: "Adding \"Learn Spanish\" pushes you past your 20 h/week study cap.",
      },
      conflicts: [
        { with: "Deep Work Block", type: "time", detail: "Overlaps Tue/Thu 19:00–20:30." },
      ],
      buffer_warning: "Wednesday has no recovery buffer left this week.",
      recommendation: "Move one Spanish session to Saturday and keep Wednesdays light.",
    },
  },
};

/** Every impact field present — the full panel. */
export const Default = {
  play: async ({ canvas }) => {
    expect(canvas.getByTestId("impact-panel")).toBeInTheDocument();
    expect(canvas.getByText(/Load: 18 h\/week → 23 h\/week/)).toBeInTheDocument();
    expect(canvas.getByText(/Overlaps Tue\/Thu/)).toBeInTheDocument();
  },
};

/** Conflicts only — no load shift, no recommendation. */
export const OnlyConflicts = {
  args: {
    impact: {
      conflicts: [
        { with: "Morning run", type: "habit", detail: "Both want 06:00–06:45." },
        { with: "Ship sprint", type: "time", detail: "Deadline week overlap." },
      ],
    },
  },
  play: async ({ canvas }) => {
    expect(canvas.getByTestId("impact-panel")).toBeInTheDocument();
    expect(canvas.queryByText(/Load:/)).toBeNull();
    expect(canvas.getByText(/Morning run/)).toBeInTheDocument();
  },
};

/** Recommendation only — the footer strip with no rows above it. */
export const OnlyRecommendation = {
  args: {
    impact: { recommendation: "Start with two sessions a week, then ramp." },
  },
  play: async ({ canvas }) => {
    expect(canvas.getByTestId("impact-panel")).toBeInTheDocument();
    expect(canvas.getByText("Start with two sessions a week, then ramp.")).toBeInTheDocument();
    expect(canvas.queryByText(/Load:/)).toBeNull();
  },
};

/** No impact payload → renders nothing. */
export const Empty = {
  args: { impact: null },
  play: async ({ canvas }) => {
    expect(canvas.queryByTestId("impact-panel")).toBeNull();
  },
};
