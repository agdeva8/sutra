import { expect, userEvent, waitFor } from "storybook/test";
import { CalendarSyncButton, CalendarSyncPrompt } from "./CalendarSync";
import { setMockCalendarFeed } from "../mock/backend";

export default {
  title: "Components/CalendarSync",
  tags: ["autodocs"],
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

/** First app open, never asked: the prompt opens by itself. */
export const FirstOpenPrompt = {
  render: () => <CalendarSyncPrompt />,
  beforeEach: () => setMockCalendarFeed({}),
};

/** Accepting flips the same dialog to "pick your calendar app". */
export const AcceptPrompt = {
  render: () => <CalendarSyncPrompt />,
  beforeEach: () => setMockCalendarFeed({}),
  play: async ({ canvasElement }) => {
    const body = canvasElement.ownerDocument.body;
    const add = await waitFor(() => {
      const b = [...body.querySelectorAll("button")].find((x) => x.textContent === "Add to my calendar");
      expect(b).toBeTruthy();
      return b;
    });
    await userEvent.click(add);
    await waitFor(() => expect(body.querySelector("[data-testid=calendar-provider-google]")).toBeTruthy());
  },
};

/** Already answered "Not now" before: nothing opens. */
export const AlreadyDeclined = {
  render: () => <CalendarSyncPrompt />,
  beforeEach: () => setMockCalendarFeed({ prompted: true }),
};

/** Timeline button when not syncing — the way back after declining. */
export const TimelineButtonOff = {
  render: () => <CalendarSyncButton />,
  beforeEach: () => setMockCalendarFeed({ prompted: true }),
};

/** Timeline button when syncing; opening it shows the links + "Stop syncing". */
export const TimelineButtonSynced = {
  render: () => <CalendarSyncButton />,
  beforeEach: () => setMockCalendarFeed({ prompted: true, enabled: true }),
  play: async ({ canvas, canvasElement }) => {
    const btn = await canvas.findByText("Synced to calendar");
    await userEvent.click(btn);
    const body = canvasElement.ownerDocument.body;
    await waitFor(() => expect(body.textContent).toContain("Stop syncing"));
  },
};
