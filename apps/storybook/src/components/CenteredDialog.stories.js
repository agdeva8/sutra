import { fn } from "storybook/test";
import { Sparkles } from "lucide-react";
import CenteredDialog from "./CenteredDialog";

export default {
  title: "Components/CenteredDialog",
  component: CenteredDialog,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onClose: fn(),
    title: "Add a milestone",
    subtitle: "Break the goal into something you can actually finish this week.",
    icon: Sparkles,
    maxWidth: "max-w-xl",
    testId: "centered-dialog",
    children: (
      <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
        Every dialog in the app — Add Goal, Add Source, Confirm a re-plan — is built on this
        shell, so the header, close button and spacing stay identical wherever it opens.
      </p>
    ),
    footer: (
      <>
        <button
          className="h-11 px-4 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors rounded"
        >
          Cancel
        </button>
        <button className="h-11 px-4 rounded bg-[var(--accent)] text-[var(--bg-primary)] text-xs font-medium hover:opacity-90 transition-opacity">
          Save milestone
        </button>
      </>
    ),
  },
};

export const Default = {};
