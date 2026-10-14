import { expect, fn, userEvent } from "storybook/test";
import Scratch from "./Scratch";

/**
 * Scratch is the reflex-capture page (docs/prd/scratchpad.md): a top nav with
 * Write / Waiting / Handled. Phone width first; the stories use the mobile
 * viewport.
 */

const INBOX = [
  {
    id: "e3",
    time: "09:31",
    body: "Interview prep: think about system design more",
    state: "needs_input",
    stateLabel: "Which goal is this for?",
    options: ["Google prep", "Career"],
  },
  { id: "e2", time: "09:14", body: "Prescription photo", state: "processing", stateLabel: "reading…" },
  { id: "e1", time: "08:55", body: "Voice note, 8 s", state: "failed", stateLabel: "Couldn't transcribe yet" },
];

const HANDLED = [
  {
    id: "h3",
    time: "08:02",
    origin: "“boss gave me the Q4 deck, needs to be out before offsite”",
    kind: "New task",
    lines: ["Q4 deck · about 3 h · Career", "Placed Thu 15 Oct"],
  },
  {
    id: "h2",
    time: "07:41",
    origin: "“dentist thursday 4pm”",
    kind: "Timetable block",
    lines: ["Thu 16:00 to 17:00", "Today adjusted"],
  },
  {
    id: "h1",
    time: "Yest.",
    origin: "“push the DSA sprint a week, travelling”",
    kind: "Proposal",
    lines: ["Would move 4 dated items. Not applied."],
    proposal: true,
  },
];

export default {
  title: "Components/Scratch",
  component: Scratch,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen", viewport: { defaultViewport: "mobile1" } },
  args: {
    inbox: INBOX,
    handled: HANDLED,
    onCapture: fn(async () => {}),
    onAnswer: fn(),
    onRetry: fn(),
    onUndo: fn(),
    onAccept: fn(),
  },
};

/** Opens on Write: the composer is the first thing under the nav. */
export const Default = {};

/** Waiting: one question open, one reading, one failed. */
export const Waiting = { args: { initialTab: "waiting" } };

/** Handled: each card shows the user's words over what the agent did. */
export const Handled = { args: { initialTab: "handled" } };

/** First open with nothing captured. */
export const EmptyWaiting = { args: { inbox: [], handled: [], initialTab: "waiting" } };

export const SendsOnEnter = {
  play: async ({ canvas, args }) => {
    const box = canvas.getByLabelText("Capture a thought");
    await userEvent.type(box, "call the landlord{Enter}");
    await expect(args.onCapture).toHaveBeenCalledWith({ kind: "text", body: "call the landlord" });
    await expect(box).toHaveValue("");
  },
};

export const KeepsTextWhenWriteFails = {
  args: {
    onCapture: fn(async () => {
      throw new Error("offline");
    }),
  },
  play: async ({ canvas }) => {
    const box = canvas.getByLabelText("Capture a thought");
    await userEvent.type(box, "do not lose me");
    // The write rejects, so the composer must keep the sentence (PRD §12).
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await expect(box).toHaveValue("do not lose me");
  },
};

export const SwitchesTabs = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("tab", { name: /Waiting/ }));
    await expect(canvas.getByText("Which goal is this for?")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("tab", { name: "Handled" }));
    await expect(canvas.getByText("Q4 deck · about 3 h · Career")).toBeInTheDocument();
  },
};

export const AnswersQuestionInline = {
  args: { initialTab: "waiting" },
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Google prep" }));
    await expect(args.onAnswer).toHaveBeenCalledWith("e3", "Google prep");
  },
};

export const ProposalNeedsReview = {
  args: { initialTab: "handled" },
  play: async ({ canvas, args }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Review" }));
    await expect(args.onAccept).toHaveBeenCalledWith("h1");
  },
};
