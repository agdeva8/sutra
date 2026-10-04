import MarkdownMessage from "./MarkdownMessage";

/**
 * MarkdownMessage renders the coach's GitHub-flavoured Markdown reply.
 * Element styling lives in `.gc-md` (index.css); only tables get a
 * scroll wrapper and links open in a new tab.
 */
export default {
  title: "Components/MarkdownMessage",
  component: MarkdownMessage,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    content: "**Bold**, _italic_, and a [link](https://example.com).",
  },
  decorators: [
    (Story) => (
      <div className="p-6 max-w-xl bg-[var(--bg-primary)] text-[var(--text-primary)] text-sm leading-relaxed">
        <Story />
      </div>
    ),
  ],
};

/** Inline formatting + a link (opens in a new tab). */
export const Default = {};

/** A wide table must scroll inside the `.gc-md-table-wrap`, not break the layout. */
export const Table = {
  args: {
    content:
      "| Plan | Hours / week |\n| --- | --- |\n| DSA refresher | 6 |\n| System design | 4 |\n| Applications & referrals | 2 |",
  },
};

/** Ordered + unordered lists and a fenced code block. */
export const CodeAndLists = {
  args: {
    content:
      "Three things to do this week:\n\n1. Draft the plan\n2. Review it with me\n3. Commit to two sessions\n\n```js\nconst sessions = ['Tue 19:00', 'Sat 09:00'];\n```",
  },
};

/** Raw HTML is NOT enabled — it renders as literal text (no injection). */
export const HtmlIsEscaped = {
  args: {
    content: "The model tried <script>alert('x')</script> but it is escaped.",
  },
};
