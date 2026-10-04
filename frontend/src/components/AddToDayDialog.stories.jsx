import React from "react";
import AddToDayDialog from "./AddToDayDialog";

/**
 * The unified add flow. Pick what it is (thing to do / unavailable) and when
 * (all day / at a time); internally it creates a commitment, a timetable
 * block, or a blocker range. One entry point instead of the old
 * Blocker / Block / Commitment trio.
 */

const state = {
  goals: [
    { id: "g1", title: "Switch into platform engineering", status: "active" },
    { id: "g2", title: "Ship the v2 landing page", status: "active" },
  ],
};

export default {
  title: "Timeline/Add to day (unified)",
  parameters: { layout: "fullscreen" },
};

const Frame = ({ kind }) => (
  <div className="min-h-[540px] bg-[var(--bg-primary)]">
    <AddToDayDialog
      open
      date={new Date()}
      state={state}
      defaultKind={kind}
      onClose={() => {}}
      onCreated={() => {}}
    />
  </div>
);

export const ThingToDo = () => <Frame kind="task" />;
export const Unavailable = () => <Frame kind="unavailable" />;
