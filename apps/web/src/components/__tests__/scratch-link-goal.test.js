/**
 * The Handled card's goal link: the label it shows, and the id the picker hands back.
 *
 * The card is presentation only, so the parent's `onLinkGoal` is the observable effect here; the
 * request itself lives in `ScratchScreen` / `lib/api.js`. An RTL renderer is not a dependency
 * of this app, so the component is mounted with `react-dom/client` and driven with real DOM clicks.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";

import Scratch from "../Scratch";

// The composer's link dialog pulls `react-markdown`, which ships untransformed ESM and dies under
// this app's Jest config. The Handled tab never opens it, so a stub keeps the import graph loadable.
jest.mock("../LinkPreviewDialog", () => () => null);

global.IS_REACT_ACT_ENVIRONMENT = true;

const GOALS = [
  { id: "g1", title: "Switch jobs" },
  { id: "g2", title: "Run a half marathon" },
];

const SKIP = "Link to a goal";

function handled(overrides = {}) {
  return {
    id: "entry_1",
    time: "14:05",
    origin: "“apply to three jobs this week”",
    kind: "todo",
    lines: ["Call the recruiter"],
    undoable: true,
    proposal: false,
    linkable: 2,
    goal: null,
    ...overrides,
  };
}

function mount(item, onLinkGoal = jest.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Scratch initialTab="handled" handled={[item]} goals={GOALS} onLinkGoal={onLinkGoal} />);
  });
  return {
    container,
    onLinkGoal,
    control: () => container.querySelector('button[aria-haspopup="dialog"]'),
    dialog: () => container.querySelector('[role="dialog"]'),
    row: (text) => [...(container.querySelector('[role="dialog"]')?.querySelectorAll("button") || [])]
      .find((b) => b.textContent.includes(text)),
    click: (el) => act(() => el.click()),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test("an entry with nothing linked invites a link", () => {
  const view = mount(handled());
  expect(view.control().textContent).toContain(SKIP);
  view.unmount();
});

test("a linked entry names its goal and offers Change", () => {
  const view = mount(handled({ goal: { id: "g1", title: "Switch jobs" } }));
  const label = view.control().textContent;
  expect(label).toContain("Goal: Switch jobs");
  expect(label).toContain("Change");
  view.unmount();
});

test("an entry that filed nothing linkable has no control", () => {
  const view = mount(handled({ linkable: 0 }));
  expect(view.control()).toBeNull();
  view.unmount();
});

test("the picker lists the active goals and hands back the chosen id", () => {
  const view = mount(handled());
  view.click(view.control());
  expect(view.dialog()).toBeTruthy();

  const chosen = view.row("Run a half marathon");
  expect(chosen).toBeTruthy();
  view.click(chosen);

  expect(view.onLinkGoal).toHaveBeenCalledWith("entry_1", "g2");
  view.unmount();
});

test("choosing No goal clears the link", () => {
  const view = mount(handled({ goal: { id: "g1", title: "Switch jobs" } }));
  view.click(view.control());
  view.click(view.row("No goal"));

  expect(view.onLinkGoal).toHaveBeenCalledWith("entry_1", null);
  view.unmount();
});
