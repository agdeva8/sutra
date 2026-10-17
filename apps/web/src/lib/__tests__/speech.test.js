import { mergeTranscript } from "../speech";

describe("merging a speech transcript", () => {
  test("base, finals and interim join with one space", () => {
    expect(mergeTranscript("I am", ["going"], "home")).toBe("I am going home");
  });

  test("runs of whitespace collapse, so padded and unpadded results read the same", () => {
    expect(mergeTranscript("I am ", [" going"], " home ")).toBe("I am going home");
    expect(mergeTranscript("  I   am", [" going "], "home  ")).toBe("I am going home");
  });

  test("a final that repeats the piece just before it is dropped", () => {
    expect(mergeTranscript("", ["I am", "I am"])).toBe("I am");
    expect(mergeTranscript("I am", ["I am"])).toBe("I am");
  });

  test("a non-adjacent repeat is kept", () => {
    expect(mergeTranscript("", ["yes", "no", "yes"])).toBe("yes no yes");
  });

  test("an empty base, finals or interim leaves no stray spaces", () => {
    expect(mergeTranscript("", [], "")).toBe("");
    expect(mergeTranscript(undefined, undefined, undefined)).toBe("");
    expect(mergeTranscript("", ["going"], "")).toBe("going");
    expect(mergeTranscript("I am", [], " home")).toBe("I am home");
  });
});
