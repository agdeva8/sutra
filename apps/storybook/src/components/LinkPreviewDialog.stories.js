import { fn } from "storybook/test";
import { expect, userEvent, waitFor } from "storybook/test";
import LinkPreviewDialog from "./LinkPreviewDialog";

/**
 * Helper — a `parameters.api` route value that answers the ask stream.
 * The fetch shim accepts a function `(url, init) => value` and lets a
 * `Response` pass through untouched, so LinkAskPanel's ReadableStream
 * reader can consume a real SSE body.
 */
const sseResponse = (events) =>
  new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );

const extractOk = {
  ok: true,
  url: "https://www.hellointerview.com/dashboard",
  final_url: "https://www.hellointerview.com/dashboard",
  extract: {
    summary:
      "This is the system-design question bank for interview prep — 8 practice questions with a grading rubric and three mock-round formats.",
    key_points: [
      "8 system-design questions ready to practice",
      "Grading rubric used in mock rounds",
      "Three session formats: solo, peer, interview",
    ],
    extractable_items: [
      "Design Uber/Lyft",
      "Design a URL shortener",
      "Design Twitter's feed",
      "Design a rate limiter",
    ],
    suggested_questions: [
      "List the interview questions — flag which fit my staff-level prep",
      "Extract the practice questions into a monthly study checklist",
    ],
  },
  error: null,
};

const previewOk = {
  ok: true,
  url: "https://www.hellointerview.com/dashboard",
  host: "www.hellointerview.com",
  title: "Hello Interview — System Design",
  description: "Practice platform for system design interviews.",
  snippet: "System design question bank. Eight questions. Grading rubric. Three mock rounds.",
  content_type: "text/html",
  status: 200,
  error: null,
};

const previewGated = {
  ok: false,
  url: "https://www.hellointerview.com/dashboard",
  host: "www.hellointerview.com",
  error: "This link is private or requires sign-in — preview not available.",
  status: 403,
};

const previewDead = {
  ok: false,
  url: "https://down.example.com",
  host: "down.example.com",
  error: "The site seems down — try again later.",
  status: 503,
};

export default {
  title: "Components/LinkPreviewDialog",
  component: LinkPreviewDialog,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    api: {
      "sources/link/preview": previewOk,
      "sources/link/extract": extractOk,
    },
  },
  args: {
    open: true,
    url: "https://www.hellointerview.com/dashboard",
    onAttach: fn(),
    onClose: fn(),
  },
};

/** A never-settling preview promise pins the dialog in its Checking state. */
export const Checking = {
  parameters: {
    api: { "sources/link/preview": new Promise(() => {}) },
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByTestId("link-preview-checking")).toBeInTheDocument();
  },
};

/** Preview + LLM extraction succeeded — the coach card and ask panel render. */
export const Extracted = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("link-preview-extract")).toBeInTheDocument();
    await expect(canvas.getByText("Design Uber/Lyft")).toBeInTheDocument();
    // Suggested questions from the extraction seed the ask panel.
    await expect(
      canvas.getByText(/List the interview questions — flag which fit my staff-level prep/),
    ).toBeInTheDocument();
  },
};

/** Reopen mode — an already-attached link source, seeded from its stored excerpt. */
export const ExistingSource = {
  args: {
    url: "https://www.hellointerview.com/dashboard",
    existingSource: {
      id: "src_link001",
      url: "https://www.hellointerview.com/dashboard",
      original_filename: "Hello Interview — System Design",
      text_excerpt:
        "8 system-design questions ready to practice\nGrading rubric used in mock rounds\nDesign Uber/Lyft\nDesign a URL shortener\nDesign a rate limiter",
    },
    onSaved: fn(),
  },
  parameters: {
    api: { "sources/src_link001": { id: "src_link001", text_excerpt: "saved" } },
  },
  play: async ({ canvas, args }) => {
    await expect(await canvas.findByTestId("link-preview-existing")).toBeInTheDocument();
    const editor = await canvas.findByTestId("source-excerpt-editor");
    await expect(editor.value).toContain("Design Uber/Lyft");
    await expect(canvas.getByTestId("source-reread")).toBeInTheDocument();
    // Save persists the edited excerpt back to the source.
    await userEvent.type(editor, " — extra note");
    await userEvent.click(canvas.getByTestId("source-save"));
    await waitFor(() => expect(args.onSaved).toHaveBeenCalled());
  },
};

/** The "Browse the page in this box" capture surface — embeddable site. */
export const BrowseEmbeddable = {
  args: {
    url: "https://www.cookingblog.com/recipe",
  },
  parameters: {
    api: {
      "sources/link/preview": {
        ...previewOk,
        url: "https://www.cookingblog.com/recipe",
        host: "www.cookingblog.com",
        title: "Weeknight Pasta — Recipe",
        embeddable: true,
      },
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("link-preview-browse-toggle")).toBeInTheDocument();
    await userEvent.click(canvas.getByTestId("link-preview-browse-toggle"));
    await expect(await canvas.findByTestId("link-preview-browse-frame")).toBeInTheDocument();
    // The capture helper is one tap under the iframe.
    await expect(canvas.getByTestId("link-preview-paste-btn")).toBeInTheDocument();
  },
};

/** The "Browse" surface when the site refuses framing (X-Frame-Options). */
export const BrowseNotEmbeddable = {
  args: {
    url: "https://www.hellointerview.com/dashboard",
  },
  parameters: {
    api: {
      "sources/link/preview": {
        ...previewOk,
        url: "https://www.hellointerview.com/dashboard",
        host: "www.hellointerview.com",
        title: "Hello Interview — System Design",
        embeddable: false,
      },
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("link-preview-browse-toggle")).toBeInTheDocument();
    await userEvent.click(canvas.getByTestId("link-preview-browse-toggle"));
    // No blank iframe — honest note + open-in-new-tab instead.
    await expect(await canvas.findByTestId("link-preview-not-embeddable")).toBeInTheDocument();
    expect(canvas.queryByTestId("link-preview-browse-frame")).toBeNull();
  },
};

/** The to-and-fro: type into the ask panel and a streamed answer lands. */
export const AskTurn = {
  parameters: {
    api: {
      "sources/link/ask": () =>
        sseResponse([
          { type: "delta", content: "From easiest to hardest: " },
          { type: "delta", content: "URL shortener, rate limiter, Uber/Lyft, Twitter feed." },
          { type: "done", message_id: "ask_1" },
        ]),
    },
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("link-preview-extract")).toBeInTheDocument();
    const input = canvas.getByTestId("link-ask-input");
    await userEvent.type(input, "Rank these by difficulty");
    await userEvent.click(canvas.getByTestId("link-ask-send"));
    await expect(
      await canvas.findByText(/URL shortener, rate limiter, Uber\/Lyft/),
    ).toBeInTheDocument();
  },
};

/** Sign-in-required page → paste fallback; "Paste" + "Read pasted text" unlock on input. */
export const Gated = {
  parameters: { api: { "sources/link/preview": previewGated } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("link-preview-gated")).toBeInTheDocument();
    // One-tap Paste button is present (no long-press needed on mobile).
    await expect(canvas.getByTestId("link-preview-paste-btn")).toBeInTheDocument();
    const ta = canvas.getByTestId("link-preview-paste");
    await userEvent.type(ta, "System design questions: Uber, URL shortener, rate limiter.");
    await expect(canvas.getByTestId("link-preview-read-paste")).toBeEnabled();
  },
};

/** Hard fetch failure (site down) — attach-anyway remains. */
export const Failed = {
  parameters: { api: { "sources/link/preview": previewDead } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByTestId("link-preview-fail")).toBeInTheDocument();
    await expect(canvas.getByTestId("link-preview-attach")).toBeEnabled();
  },
};