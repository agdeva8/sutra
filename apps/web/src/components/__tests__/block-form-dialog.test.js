/**
 * The bottom-sheet behaviours the iPhone build relies on: a pinned action footer that offers a
 * destructive Delete for an existing block, Delete asking a second time inline, and native
 * date/time fields that are allowed to shrink inside their grid track.
 *
 * An RTL renderer is not a dependency of this app, so the dialog is mounted with
 * `react-dom/client` and driven with real DOM clicks, as `scratch-link-goal.test.js` does.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";

import BlockFormDialog from "../BlockFormDialog";

global.IS_REACT_ACT_ENVIRONMENT = true;

const existing = {
  id: "block_1",
  block_kind: "event",
  title: "QA test block - delete me",
  day: "2026-10-15",
  start: "11:00",
  end: "12:00",
  note: "a note",
};

function mount(props = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <BlockFormDialog
        open
        onClose={jest.fn()}
        onSave={jest.fn()}
        {...props}
      />,
    );
  });
  return {
    container,
    byTestId: (id) => container.querySelector(`[data-testid="${id}"]`),
    click: (el) => act(() => el.click()),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test("an existing block's footer renders Save and a labelled Delete", () => {
  const onDelete = jest.fn();
  const view = mount({ editing: existing, onDelete });

  expect(view.byTestId("block-form-submit").textContent).toContain("Save");
  const del = view.byTestId("block-form-delete");
  expect(del.textContent).toBe("Delete event");
  // The action row is the sheet footer, which the shared component pins.
  expect(del.parentElement.className).toContain("gc-dialog-footer");

  view.unmount();
});

test("Delete needs a second tap to confirm", () => {
  const onDelete = jest.fn();
  const view = mount({ editing: existing, onDelete });

  const del = view.byTestId("block-form-delete");
  view.click(del);
  expect(onDelete).not.toHaveBeenCalled();
  expect(del.textContent).toContain("tap again to confirm");

  view.click(del);
  expect(onDelete).toHaveBeenCalledWith("block_1");

  view.unmount();
});

test("date and time inputs carry the min-width rule", () => {
  const view = mount({ editing: existing });

  const nativeFields = view.container.querySelectorAll('input[type="date"], input[type="time"]');
  expect(nativeFields.length).toBeGreaterThan(0);
  nativeFields.forEach((input) => {
    expect(input.classList.contains("gc-native-datetime")).toBe(true);
  });

  view.unmount();
});
