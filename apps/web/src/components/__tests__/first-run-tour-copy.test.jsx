/**
 * The first-run tour's words, and the carousel it borrows on the Meet Scratch step.
 *
 * An RTL renderer is not a dependency of this app, so the carousel is mounted with
 * `react-dom/client` and its controls are read straight off the DOM, the same way the
 * other component tests here do it.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";

import FirstRunTour, { COPY } from "../FirstRunTour";
import ScratchExamples from "../ScratchExamples";

global.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // jsdom ships no matchMedia, and both components ask it whether motion is reduced.
  // A plain function, not a `jest.fn`: the config resets mocks between tests, and a
  // reset mock would return undefined where the components expect a MediaQueryList.
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
});

function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** The carousel's own edge arrows — the controls the tour step must not show. */
const carouselArrows = (container) =>
  container.querySelectorAll(
    'button[aria-label="Previous example"], button[aria-label="Next example"]'
  );

describe("the first-run tour's copy", () => {
  test("timeline_screen sells the Sync to calendar button, and bolds it", () => {
    const { line, emphasis } = COPY.timeline_screen;

    expect(line).toBe(
      "Sync straight to your Google or Outlook calendar with the Sync to calendar button."
    );
    // The card bolds `emphasis` by finding it in the line; if it is not there, nothing is bold.
    expect(emphasis).toBe("Sync to calendar");
    expect(line).toContain(emphasis);
  });
});

describe("the Meet Scratch carousel", () => {
  test("with interactive={false} it shows no arrows, so the tour's edge zones get the taps", () => {
    const { container, unmount } = render(<ScratchExamples interactive={false} />);

    expect(carouselArrows(container)).toHaveLength(0);
    // The dots are still there to choose an example with.
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(6);
    unmount();
  });

  test("by default it keeps its arrows, so the carousel works on its own elsewhere", () => {
    const { container, unmount } = render(<ScratchExamples />);

    expect(carouselArrows(container)).toHaveLength(2);
    unmount();
  });
});

describe("the tour card", () => {
  test("the Meet Scratch step renders the carousel without its own arrows", () => {
    // The dialog step is index 8; a guest sees every step from the sign-in card on.
    localStorage.setItem(
      "sutra.firstRunTour",
      JSON.stringify({ step: 8, done: false })
    );
    const onRunChange = jest.fn();

    const { container, unmount } = render(
      <FirstRunTour ready isGuest onRunChange={onRunChange} />
    );

    expect(container.querySelector('[data-testid="scratch-examples"]')).not.toBeNull();
    expect(carouselArrows(container)).toHaveLength(0);
    // The tour's own navigation is still there.
    expect(container.querySelector('[data-testid="first-run-tour-prev"]')).not.toBeNull();
    unmount();
    localStorage.clear();
  });
});
