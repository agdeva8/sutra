/**
 * firstRunTour.js keeps its state — the in-memory copy and the listener set — at
 * module level, so every test loads a fresh copy with `jest.isolateModules`.
 *
 * The storage spies go on `Storage.prototype`, not on the `localStorage` object:
 * jsdom's `Storage` is a Proxy that swallows the assignment `jest.spyOn` makes,
 * so `jest.spyOn(localStorage, "getItem")` hands back the real `getItem` rather
 * than a mock. Overriding the prototype method is what `localStorage.getItem`
 * actually resolves to, and it is visible through the Proxy.
 */

let getItemSpy;
let setItemSpy;

beforeEach(() => {
  localStorage.clear();
  getItemSpy = jest.spyOn(window.Storage.prototype, "getItem");
  setItemSpy = jest.spyOn(window.Storage.prototype, "setItem");
});

afterEach(() => {
  getItemSpy.mockRestore();
  setItemSpy.mockRestore();
  jest.resetModules();
});

/** A fresh copy of the module, reading whatever localStorage currently holds. */
function load() {
  let mod;
  jest.isolateModules(() => {
    mod = require("../firstRunTour");
  });
  return mod;
}

const blocked = () => {
  throw new Error("storage blocked");
};

describe("the first-run tour", () => {
  describe("step order", () => {
    test("the steps are declared in the order the tour runs them", () => {
      const { TOUR_STEPS, LAST_STEP } = load();
      expect(TOUR_STEPS.map((step) => step.key)).toEqual([
        "signin",
        "goal_nav",
        "goal_screen",
        "timeline_nav",
        "timeline_screen",
        "today_nav",
        "today_screen",
        "scratch_nav",
        "scratch_dialog",
        "scratch_screen",
        "more_nav",
      ]);
      expect(LAST_STEP).toBe(TOUR_STEPS.length - 1);
    });

    test("every step is one of the four kinds the tour knows how to show", () => {
      const { TOUR_STEPS } = load();
      const kinds = new Set(["card", "nav", "screen", "dialog"]);
      for (const step of TOUR_STEPS) expect(kinds.has(step.kind)).toBe(true);
      // Every nav step names the screen (or screens) that complete it.
      for (const step of TOUR_STEPS.filter((s) => s.kind === "nav")) {
        expect(Boolean(step.panel || step.panels)).toBe(true);
      }
    });

    test("a new tour starts at the first step and moves one step at a time", () => {
      const tour = load();
      expect(tour.readTourState()).toEqual({ step: 0, done: false });

      for (let step = 0; step < tour.LAST_STEP; step += 1) {
        tour.advanceTour(step);
        expect(tour.readTourState()).toEqual({ step: step + 1, done: false });
      }
      expect(tour.readTourState().step).toBe(tour.LAST_STEP);
      expect(tour.readTourState().done).toBe(false);
    });

    test("shownStep skips the sign-in step for a signed-in user but not for a guest", () => {
      const { shownStep, TOUR_STEPS } = load();
      const signin = TOUR_STEPS.findIndex((step) => step.guestsOnly);
      expect(signin).toBe(0);

      expect(shownStep(0, true)).toBe(0);
      expect(shownStep(0, false)).toBe(1);
    });

    test("shownStep leaves every later step where it is, guest or not", () => {
      const { shownStep, LAST_STEP } = load();
      for (let step = 1; step <= LAST_STEP; step += 1) {
        expect(shownStep(step, true)).toBe(step);
        expect(shownStep(step, false)).toBe(step);
      }
    });
  });

  describe("advancing", () => {
    test("advanceTour moves on from the step being shown, not the stored one", () => {
      const tour = load();
      // Stored 0, but a signed-in user is being shown step 1 — advancing from the
      // stored index would leave them on the same card for ever.
      expect(tour.readTourState().step).toBe(0);
      tour.advanceTour(tour.shownStep(tour.readTourState().step, false));
      expect(tour.readTourState()).toEqual({ step: 2, done: false });
    });

    test("a signed-in user whose stored step is the sign-in step still moves forward", () => {
      const tour = load();
      expect(tour.readTourState().step).toBe(0);

      const showing = tour.shownStep(tour.readTourState().step, false);
      expect(showing).toBe(1);
      tour.advanceTour(showing);

      expect(tour.readTourState().step).toBe(2);
      expect(tour.shownStep(tour.readTourState().step, false)).toBe(2);
    });

    test("advancing past the last step ends the tour", () => {
      const tour = load();
      tour.advanceTour(tour.LAST_STEP - 1);
      expect(tour.readTourState()).toEqual({ step: tour.LAST_STEP, done: false });

      tour.advanceTour(tour.LAST_STEP);
      expect(tour.readTourState()).toEqual({ step: tour.LAST_STEP, done: true });
    });

    test("goToStep jumps straight to a step, and past the end ends the tour", () => {
      const tour = load();
      tour.goToStep(6);
      expect(tour.readTourState()).toEqual({ step: 6, done: false });
      expect(load().readTourState()).toEqual({ step: 6, done: false });

      tour.goToStep(tour.LAST_STEP + 1);
      expect(tour.readTourState()).toEqual({ step: tour.LAST_STEP, done: true });
    });

    test("arrivesAt reads one screen, or any of several", () => {
      const { arrivesAt, TOUR_STEPS, MORE_PANELS } = load();
      const stepFor = (key) => TOUR_STEPS.find((step) => step.key === key);

      expect(arrivesAt(stepFor("goal_nav"), "state")).toBe(true);
      expect(arrivesAt(stepFor("goal_nav"), "today")).toBe(false);
      expect(arrivesAt(stepFor("goal_nav"), "")).toBe(false);

      for (const panel of MORE_PANELS) {
        expect(arrivesAt(stepFor("more_nav"), panel)).toBe(true);
      }
      expect(arrivesAt(stepFor("more_nav"), "state")).toBe(false);
    });

    test("nextNavStep passes over the screen step that follows a nav step", () => {
      const tour = load();
      const indexOf = (key) => tour.TOUR_STEPS.findIndex((step) => step.key === key);

      // Goal nav → over its screen step → Timeline nav.
      expect(tour.nextNavStep(indexOf("goal_nav"))).toBe(indexOf("timeline_nav"));
      expect(tour.nextNavStep(indexOf("timeline_nav"))).toBe(indexOf("today_nav"));
      expect(tour.nextNavStep(indexOf("today_nav"))).toBe(indexOf("scratch_nav"));
      // Scratch's dialog and composer steps are passed over too.
      expect(tour.nextNavStep(indexOf("scratch_nav"))).toBe(indexOf("more_nav"));
      // There is no nav step after the last one.
      expect(tour.nextNavStep(indexOf("more_nav"))).toBe(-1);
    });
  });

  describe("jumping from a progress dot", () => {
    /** The step indices a dot can reach, by key. */
    const jump = (tour, key, panelView) =>
      tour.stepOnJump(
        tour.TOUR_STEPS.findIndex((step) => step.key === key),
        panelView
      );
    const indexOf = (tour, key) => tour.TOUR_STEPS.findIndex((step) => step.key === key);

    test("a step that is not a screen step is shown wherever the user is standing", () => {
      const tour = load();
      expect(jump(tour, "signin", "state")).toBe(indexOf(tour, "signin"));
      expect(jump(tour, "goal_nav", "today")).toBe(indexOf(tour, "goal_nav"));
      expect(jump(tour, "scratch_dialog", "state")).toBe(indexOf(tour, "scratch_dialog"));
      expect(jump(tour, "more_nav", "timeline")).toBe(indexOf(tour, "more_nav"));
    });

    test("a screen step whose screen is open is shown directly", () => {
      const tour = load();
      expect(jump(tour, "goal_screen", "state")).toBe(indexOf(tour, "goal_screen"));
      expect(jump(tour, "timeline_screen", "timeline")).toBe(indexOf(tour, "timeline_screen"));
      expect(jump(tour, "today_screen", "today")).toBe(indexOf(tour, "today_screen"));
      expect(jump(tour, "scratch_screen", "scratch")).toBe(indexOf(tour, "scratch_screen"));
    });

    test("a screen step whose screen is not open lands on the nav step that opens it", () => {
      const tour = load();
      expect(jump(tour, "goal_screen", "timeline")).toBe(indexOf(tour, "goal_nav"));
      expect(jump(tour, "timeline_screen", "state")).toBe(indexOf(tour, "timeline_nav"));
      expect(jump(tour, "today_screen", "")).toBe(indexOf(tour, "today_nav"));
      // Scratch's composer is reached through its nav step too, dialog and all.
      expect(jump(tour, "scratch_screen", "today")).toBe(indexOf(tour, "scratch_nav"));
    });

    test("a jump lands on a step the tour can show, never past the end", () => {
      const tour = load();
      for (let i = 0; i < tour.TOUR_STEPS.length; i += 1) {
        for (const panel of ["", "state", "timeline", "today", "scratch", "todos"]) {
          const landed = tour.stepOnJump(i, panel);
          expect(landed).toBeGreaterThanOrEqual(0);
          expect(landed).toBeLessThanOrEqual(tour.LAST_STEP);
        }
      }
    });
  });

  describe("ending", () => {
    test("endTour marks it done, and it stays done across a reload", () => {
      const tour = load();
      tour.endTour();
      expect(tour.readTourState()).toEqual({ step: tour.LAST_STEP, done: true });

      const reloaded = load();
      expect(reloaded.readTourState()).toEqual({ step: reloaded.LAST_STEP, done: true });
    });

    test("ending from the middle of the tour still finishes it", () => {
      const tour = load();
      tour.advanceTour(0);
      tour.advanceTour(1);
      expect(tour.readTourState().done).toBe(false);

      tour.endTour();
      expect(tour.readTourState()).toEqual({ step: tour.LAST_STEP, done: true });
    });
  });

  describe("replay", () => {
    test("restartTour starts it over from the beginning", () => {
      const tour = load();
      tour.endTour();
      expect(tour.readTourState().done).toBe(true);

      tour.restartTour();
      expect(tour.readTourState()).toEqual({ step: 0, done: false });
    });

    test("restartTour from a mid-tour step goes back to the top, and persists", () => {
      const tour = load();
      tour.advanceTour(0);
      tour.advanceTour(1);
      tour.advanceTour(2);
      expect(tour.readTourState().step).toBe(3);

      tour.restartTour();
      expect(tour.readTourState()).toEqual({ step: 0, done: false });

      const reloaded = load();
      expect(reloaded.readTourState()).toEqual({ step: 0, done: false });
    });
  });

  describe("storage", () => {
    test("state persists through localStorage under the module's key", () => {
      const tour = load();
      tour.advanceTour(0);

      expect(setItemSpy).toHaveBeenCalledTimes(1);
      expect(setItemSpy).toHaveBeenCalledWith(
        tour.FIRST_RUN_TOUR_KEY,
        JSON.stringify({ step: 1, done: false })
      );
      expect(JSON.parse(localStorage.getItem(tour.FIRST_RUN_TOUR_KEY))).toEqual({
        step: 1,
        done: false,
      });

      const reloaded = load();
      expect(reloaded.readTourState()).toEqual({ step: 1, done: false });
    });

    test("a stored value from an older or hand-edited build is folded into a runnable step", () => {
      const tour = load();

      localStorage.setItem(tour.FIRST_RUN_TOUR_KEY, JSON.stringify({ step: 99, done: false }));
      expect(tour.readTourState()).toEqual({ step: tour.LAST_STEP, done: false });

      localStorage.setItem(tour.FIRST_RUN_TOUR_KEY, JSON.stringify({ step: -3 }));
      expect(tour.readTourState()).toEqual({ step: 0, done: false });

      localStorage.setItem(tour.FIRST_RUN_TOUR_KEY, "not json{{{");
      expect(tour.readTourState()).toEqual({ step: 0, done: false });
    });

    test("when localStorage throws, the in-memory fallback still works", () => {
      getItemSpy.mockImplementation(blocked);
      setItemSpy.mockImplementation(blocked);

      const tour = load();
      const onChange = jest.fn();
      tour.onTourChange(onChange);

      expect(tour.readTourState()).toEqual({ step: 0, done: false });

      tour.advanceTour(0);
      expect(tour.readTourState()).toEqual({ step: 1, done: false });
      expect(onChange).toHaveBeenCalledTimes(1);

      tour.advanceTour(1);
      expect(tour.readTourState()).toEqual({ step: 2, done: false });

      tour.endTour();
      expect(tour.readTourState()).toEqual({ step: tour.LAST_STEP, done: true });

      tour.restartTour();
      expect(tour.readTourState()).toEqual({ step: 0, done: false });
    });
  });

  describe("listeners", () => {
    test("onTourChange listeners fire on a change and stop after they unsubscribe", () => {
      const tour = load();
      const first = jest.fn();
      const second = jest.fn();

      const unsubscribeSecond = tour.onTourChange(second);
      tour.onTourChange(first);

      tour.advanceTour(0);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenCalledWith({ step: 1, done: false });

      // Reading is not a change.
      tour.readTourState();
      expect(first).toHaveBeenCalledTimes(1);

      unsubscribeSecond();
      tour.advanceTour(1);
      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenLastCalledWith({ step: 2, done: false });
    });

    test("ending and restarting both notify", () => {
      const tour = load();
      const onChange = jest.fn();
      tour.onTourChange(onChange);

      tour.endTour();
      expect(onChange).toHaveBeenLastCalledWith({ step: tour.LAST_STEP, done: true });

      tour.restartTour();
      expect(onChange).toHaveBeenLastCalledWith({ step: 0, done: false });
      expect(onChange).toHaveBeenCalledTimes(2);
    });
  });
});
