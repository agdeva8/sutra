# Sutra — develop_v2 Storybook

A standalone Storybook built in the empty `develop_v2` worktree, reusing
components from the main worktree. Open it, click through the app, file bugs.
The main worktree was **not modified**.

```bash
pnpm install
pnpm storybook        # → http://localhost:6007
```

Port **6007**, not Storybook's usual 6006 — something else already holds 6006 on
this machine.

## Playing with the app

`App / Screens` is the main folder. Nine stories, one per screen — Overview,
Plan, Goals, Today, Timeline, Memories, Sources, Curated, Settings — each
rendering the real thing: the header, the panel, the chat button, the dialogs.

**It is live, not a mockup.** Every screen talks to the in-page mock backend in
`src/mock/`, and writes mutate it:

- tick a task, and it stays ticked
- open the chat, send a turn, and watch it stream token by token
- confirm a proposal and the goal count really goes up (3 → 4)

A small **status pill** sits bottom-left (the app's own controls are
bottom-right, so they never overlap). It tells you whether every endpoint the
current screen asked for had a fixture — which is the difference between "this
panel is blank because the mock has no data" and "this panel is blank because
the UI is broken". Press `b` to collapse it.

## Why `AppShell`, not `App`

Each screen renders `src/AppShell.jsx` rather than `src/App.js`. That is forced,
not tidiness:

`App.js` renders a `BrowserRouter` with a catch-all route
(`<Route path="*" element={<Navigate to="/" replace/>}>`). Inside Storybook's
iframe the path is `/iframe.html`, so that catch-all rewrites the URL, navigates
the canvas away, and the story renders **blank** — verified, with zero console
errors and a rewritten URL.

So `AppShell` mirrors `App.js`'s composition — same providers, same two routes,
same `Toaster` bridge, same `<div className="App">` root — with a seeded
`MemoryRouter` instead of `BrowserRouter`. It is ~30 lines and deliberately kept
to the same shape so the diff stays obvious.

**The cost:** it is a hand-maintained mirror. If `App.js` gains a provider, a
route or a global, `AppShell.jsx` must be updated to match or the screens
silently drift. `src/App.js` is kept here precisely so the mirror stays
checkable against it.

Because there are no real URLs inside Storybook, everything routes off
`?panel=<key>` seeded into the memory router (see `src/constants/screens.js`).

## What was reused, and what was left behind

Every file under `src/` was copied from the main worktree's `frontend/src`,
selected by reachability from the app's own entry point. Only components wired
into the working UI came across.

**Excluded (55 files), because they are not in the working UI:**

| What | Why |
|---|---|
| `OnboardingBanner`, `PlanCalendar`, `PlanBreakdown` | Story-only, or imported by nothing |
| 40 `components/ui/*.jsx` | shadcn primitives never imported (`button`, `dialog`, `card`, …); only `dropdown-menu`, `popover`, `select`, `tabs` are live |
| `hooks/use-toast.js`, `constants/testIds/*`, `lib/__tests__/*` | Unreferenced by any live module |
| `CalendarLayoutOptions` / `CalendarNestedSpans` stories | Self-described "design samples" with mocked markup |

## Defects this found

Three real defects, all **pre-existing in the main worktree** — fixed in the
copies here, main left alone. Each is worth fixing there too.

1. **`Timeline.stories.js` declared `plan_items` twice.** The later key silently
   swallowed the two daily plan items, and Storybook refused to build
   ("Duplicate key `plan_items` in object literal"). Merged into one key.

2. **`RefineModal`, `RejectModal`, `ToolConfirmationPrompt`, `GoalMenu` stories
   read `component` out of `args`** — `const { component } = args`. Storybook
   puts the component on the story *context*, so it was `undefined` and all 14
   occurrences threw `TypeError: component is not a function`. Now destructured
   from the second `render` argument.

3. **`LinkAskPanel`'s `Empty` story asserted copy that no longer exists** — it
   looked for `/Ask for anything/`, but the placeholder is `Ask the coach…`, so
   its interaction test failed on every run.

## Files that are not copied from main

Everything else under `src/` came from the main worktree. These are additions:

- `src/AppShell.jsx` — the iframe-compatible app root described above.
- `src/Screens.stories.jsx` — the nine screen stories, plus the status pill.
- `src/mock/backend.js` — patches `window.fetch`, serves all `/api/*`.
- `src/mock/fixtures.js` — seed data and the write mutations.
- `src/mock/image-fallback.js` — placeholder for memory photos.
- `.storybook/main.js`, `.storybook/preview.jsx` — config.

## Notes

- `.storybook/main.js` carries three things that used to come from the project's
  `vite.config.js`, which no longer exists:
  - the `@/*` → `src/*` alias (craco gave the original app this)
  - a JSX loader for `.js` files — CRA parsed JSX in `.js` and most copied
    components are `.js`; esbuild defaults `.js` to the plain JS loader
  - `process.env.REACT_APP_BACKEND_URL`, which `src/lib/api.js` reads to build
    the API base. Without the define it is a `ReferenceError` at module load.
  - plus `@vitejs/plugin-react`, which provides the automatic JSX runtime.
    Without it every `.js` component throws `React is not defined`.
- Response envelopes in the mock are deliberately non-uniform, matching the live
  contract: `/chat/history`, `/audit`, `/blockers`, `/timetable` and `/sources`
  are bare arrays, while `/memories` is wrapped in `{ memories }`.
- Memory photos point at `${API}/sources/:id/download`, an `<img>` load rather
  than a `fetch`, so the mock cannot answer it. `src/mock/image-fallback.js`
  swaps the failed image for an inline placeholder; the one-off console `404` is
  expected — the request has to fail before the handler fires.

## Verified

- `pnpm build-storybook` succeeds.
- All 9 screens render with no console errors.
- The chat streams token-by-token inside Storybook, and confirming a proposal
  adds a real goal.
- All 58 story titles render clean (154 stories; 206 entries including docs).
