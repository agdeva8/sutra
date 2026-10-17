import { MOBILE_LANDING_SCREEN, MOBILE_TAB_KEYS, SCREENS } from "../../constants/screens";

describe("the mobile tab bar", () => {
  test("pins Scratch, Goal, Today and Timeline", () => {
    expect(MOBILE_TAB_KEYS).toEqual(["scratch", "state", "today", "timeline"]);
  });

  test("every pinned key is a real screen", () => {
    const keys = SCREENS.map((s) => s.key);
    for (const key of MOBILE_TAB_KEYS) expect(keys).toContain(key);
  });

  test("To-dos is not pinned", () => {
    expect(MOBILE_TAB_KEYS).not.toContain("todos");
  });

  test("a phone lands on Scratch", () => {
    expect(MOBILE_LANDING_SCREEN).toBe("scratch");
  });
});
