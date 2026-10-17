// The dialog pulls in children that use the `@/` alias and an ESM-only markdown stack, neither of
// which CRA's Jest setup resolves. The helper under test is pure, so stub the dialog's imports
// rather than change the test config.
jest.mock("../../components/CenteredDialog", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/ChatConsole", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/RefineModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/RejectModal", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/SourcesAskCard", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/AboutYouCard", () => ({ __esModule: true, default: () => null }));
jest.mock("../../components/RenegotiationDialog", () => ({ __esModule: true, default: () => null }));
jest.mock("../../hooks/useDialogBack", () => ({ useDialogBack: () => {} }));
jest.mock("../../hooks/use-plan-send", () => ({
  usePlanSend: () => ({}),
  renegotiationChoiceLabel: () => "",
  clearRenegotiation: () => {},
}));
jest.mock("../../hooks/useDraftPersistence", () => ({
  readDraftBucket: () => null,
  writeDraftBucket: () => {},
  clearDraftBucket: () => {},
}));
jest.mock("../../lib/api", () => ({ api: {}, API: {} }));
jest.mock("../../lib/sources", () => ({ SOURCE_FILE_ACCEPT: "", sourceChipLabel: () => "" }));
jest.mock("../../lib/goalPlanning", () => ({ buildSchedule: () => {} }));
jest.mock("sonner", () => ({ toast: { error: () => {} } }));

import { newestPendingCreateGoal } from "../../components/AddGoalDialog";

const goal = (id, extra = {}) => ({ id, action: "create_goal", args: { title: id }, status: "pending", ...extra });
const milestone = (id) => ({ id, action: "add_milestone", args: { title: id }, status: "pending" });

describe("newestPendingCreateGoal", () => {
  it("answers null when the conversation has no goal card", () => {
    expect(newestPendingCreateGoal([])).toBeNull();
    expect(newestPendingCreateGoal([{ proposals: [milestone("m1")] }])).toBeNull();
  });

  it("keeps the last create_goal within one reply", () => {
    const messages = [{ id: "a1", proposals: [goal("old"), milestone("m1"), goal("new")] }];
    expect(newestPendingCreateGoal(messages).id).toBe("new");
  });

  it("prefers a newer message over an older pending goal", () => {
    const messages = [
      { id: "a1", proposals: [goal("old")] },
      { id: "a2", proposals: [goal("new")] },
    ];
    expect(newestPendingCreateGoal(messages).id).toBe("new");
  });

  it("ignores a resolved goal when an older one is still pending", () => {
    const messages = [
      { id: "a1", proposals: [goal("old")] },
      { id: "a2", proposals: [goal("done", { status: "confirmed" })] },
    ];
    expect(newestPendingCreateGoal(messages).id).toBe("old");
  });
});
