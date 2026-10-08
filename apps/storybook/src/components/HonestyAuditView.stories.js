import { fn } from "storybook/test";
import HonestyAuditView from "./HonestyAuditView";

// GET /api/audit returns a bare array of timestamped state changes.
const events = [
  {
    id: "a1",
    created_at: "2026-09-30T09:14:00Z",
    type: "goal_created",
    summary: 'Created goal "Run a marathon" (horizon: long)',
  },
  {
    id: "a2",
    created_at: "2026-09-30T09:21:00Z",
    type: "milestone_confirmed",
    summary: 'Confirmed milestone "First 10k race" for 2026-10-06',
  },
  {
    id: "a3",
    created_at: "2026-09-30T09:44:00Z",
    type: "reject_commitment",
    summary: "Rejected proposal to add a daily journaling commitment",
  },
  {
    id: "a4",
    created_at: "2026-09-30T10:02:00Z",
    type: "source_added",
    summary: 'Attached source "interview-notes.pdf" to "Switch into platform engineering"',
  },
];

export default {
  title: "Components/HonestyAuditView",
  component: HonestyAuditView,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: { audit: events },
  },
  args: {
    open: true,
    onClose: fn(),
  },
};

export const Default = {};
