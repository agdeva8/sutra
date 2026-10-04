import { fn } from "storybook/test";
import { expect, userEvent } from "storybook/test";
import LinkAskPanel from "./LinkAskPanel";

const sseResponse = (events) =>
  new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

export default {
  title: "Components/LinkAskPanel",
  component: LinkAskPanel,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: {
      "sources/link/ask": () =>
        sseResponse([
          { type: "delta", content: "The page lists 8 system-design questions. " },
          { type: "delta", content: "Easiest first: URL shortener, rate limiter, Uber/Lyft." },
          { type: "done", message_id: "ask_1" },
        ]),
    },
  },
  args: {
    url: "https://www.hellointerview.com/dashboard",
    text: "",
    suggestions: ["Rank by difficulty", "Turn the top 3 into a prep plan"],
    disabled: false,
  },
};

export const Empty = {
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("link-ask-panel")).toBeInTheDocument();
    await expect(canvas.getByText(/Ask for anything/)).toBeInTheDocument();
  },
};

export const WithSuggestions = {
  args: {
    suggestions: ["Rank by difficulty", "Turn the top 3 into a prep plan", "Explain the rubric"],
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Rank by difficulty")).toBeInTheDocument();
  },
};

export const StreamedTurn = {
  play: async ({ canvas }) => {
    const input = canvas.getByTestId("link-ask-input");
    await userEvent.type(input, "Rank these by difficulty{enter}");
    await expect(
      await canvas.findByText(/Easiest first: URL shortener, rate limiter/),
    ).toBeInTheDocument();
  },
};

export const Disabled = {
  args: { disabled: true },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("link-ask-input")).toBeDisabled();
    await expect(canvas.getByTestId("link-ask-send")).toBeDisabled();
  },
};