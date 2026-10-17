import { SOURCE_FILE_ACCEPT, sourceChipLabel, sourceTypeLabel } from "../sources";
import { SOURCES_EXPLAINER_KEY, hasSeenSourcesExplainer, markSourcesExplainerSeen } from "../sourcesExplainer";

describe("source chips", () => {
  test("a link is a Link, whatever its URL ends in", () => {
    expect(sourceTypeLabel({ kind: "link", url: "https://x.com/syllabus.pdf" })).toBe("Link");
  });

  test("a file's extension names its type", () => {
    expect(sourceTypeLabel({ kind: "file", original_filename: "resume.PDF" })).toBe("PDF");
    expect(sourceTypeLabel({ kind: "file", original_filename: "board.jpeg" })).toBe("Photo");
    expect(sourceTypeLabel({ kind: "file", original_filename: "notes.md" })).toBe("Document");
  });

  test("the chip shows the name the user knows, then the type", () => {
    expect(sourceChipLabel({ kind: "file", original_filename: "resume.pdf" })).toBe("resume.pdf · PDF");
    expect(sourceChipLabel({})).toBe("Source · Document");
  });

  test("the picker offers only what the API can read", () => {
    const accepted = SOURCE_FILE_ACCEPT.split(",");
    expect(accepted).toEqual(expect.arrayContaining([".pdf", ".png", ".jpg", "application/pdf"]));
    expect(accepted).not.toContain(".doc");
    expect(accepted).not.toContain(".docx");
  });
});

describe("sources explainer", () => {
  beforeEach(() => localStorage.clear());

  test("seen once, it stays seen across reloads", () => {
    markSourcesExplainerSeen();
    expect(localStorage.getItem(SOURCES_EXPLAINER_KEY)).toBe("1");
    expect(hasSeenSourcesExplainer()).toBe(true);
  });

  test("when storage throws, the in-memory flag still holds for the session", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    markSourcesExplainerSeen();
    expect(hasSeenSourcesExplainer()).toBe(true);
    setItem.mockRestore();
    getItem.mockRestore();
  });
});
