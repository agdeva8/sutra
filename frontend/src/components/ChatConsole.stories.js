import { fn } from "storybook/test";
import ChatConsole from "./ChatConsole";

/**
 * ChatConsole is the shared chat surface behind the global chat modal, the Add
 * Goal dialog, and focused-task chats. It fills its parent (`h-full`), so every
 * story wraps it in a 100vh box — otherwise the log collapses to zero height.
 */
export default {
  title: "Components/ChatConsole",
  component: ChatConsole,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: {
    messages: [],
    input: "",
    setInput: fn(),
    sending: false,
    onSend: fn(),
    onConfirm: fn(),
    onReject: fn(),
    onRefine: fn(),
    onOpenRefine: fn(),
    onOpenReject: fn(),
    busyProposal: null,
    autoAnswer: false,
    setAutoAnswer: fn(),
    grillMe: false,
    setGrillMe: fn(),
    onUploadFile: fn(),
    onAddLink: fn(),
    sources: [],
    onDeleteSource: fn(),
    onClearChat: fn(),
    pendingClarifications: null,
    onAnswerClarification: fn(),
    onDismissClarifications: fn(),
    showSources: true,
    focusOnMount: false,
    scopeLabel: "",
    scopeIntent: "",
    onViewGoal: null,
  },
  decorators: [
    (Story) => (
      <div style={{ height: "100vh" }}>
        <Story />
      </div>
    ),
  ],
};

export const Empty = {};

export const WithMessage = {
  args: {
    messages: [
      { id: "u1", role: "user", content: "I want to set a health goal", proposals: [], streaming: false },
      {
        id: "a1",
        role: "assistant",
        content: "I propose a health goal with three milestones.",
        proposals: [
          {
            id: "prop_1",
            action: "create_goal",
            args: {
              title: "Health goal",
              horizon: "short",
              why: "Be healthier",
              first_action: "Walk 10 min daily",
              target_date: "2026-12-01",
            },
            status: "pending",
          },
        ],
        streaming: false,
      },
    ],
  },
};

/**
 * The grill/ask clarification turn: the card sits at the END of the transcript
 * (so the reply and the questions scroll together, composer pinned), options
 * are select-then-submit, and unanswered questions fall to the free-text box.
 */
export const WithClarifications = {
  args: {
    messages: [
      { id: "u1", role: "user", content: "I want to switch jobs in 3 months", proposals: [], streaming: false },
      {
        id: "a1",
        role: "assistant",
        content:
          "Before I plan this, I need three things — they change the shape of the plan more than the deadline does.",
        proposals: [],
        streaming: false,
      },
    ],
    pendingClarifications: {
      messageId: "a1",
      prompt: "Job switch in 3 months with no stated readiness, application status, or weekly hours.",
      questions: [
        {
          question: "What is your current interview readiness for the roles you're targeting?",
          options: [
            "DSA/data structures not started",
            "DSA rusty, needs practice",
            "DSA solid, system design weak",
            "System design solid, behavioral weak",
            "All three need work",
          ],
        },
        {
          question: "Which parts of the process should the plan cover?",
          multi: true,
          options: [
            "DSA / algorithms refresher",
            "System design",
            "Behavioral / LP stories",
            "Applications + referrals",
            "Mock interviews",
          ],
        },
        {
          question: "How many hours per week can you realistically dedicate to this?",
          options: ["Under 5h", "5–10h", "10–15h", "15h+"],
        },
      ],
    },
  },
};
