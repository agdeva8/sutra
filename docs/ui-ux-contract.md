# Sutra — UI/UX Contract

The single source of truth for the app's look & feel, theme, screens, and mobile
interaction rules. Read this before any frontend/UI work; when code and this doc
disagree, the code wins — update this doc in the same change.

**North star:** *smooth, intuitive, clean.* Every screen, transition, and control
should feel native and obvious. Nothing flickers, jumps, or needs explaining.

---

## 1. Aesthetic

| Property | Value |
|---|---|
| Direction | **Apple HIG-inspired** ("Apple-clean") |
| Default mode | **Light-first** — `sutra_theme` defaults to `light` |
| Alternate | Dark mode toggle (`.light` class on `<html>`, persisted to `localStorage`) |
| Viewport priority | **Mobile-first** — base styles are the phone; `sm:`/`md:`/`lg:` enhance upward |
| Voice | Precise, rigorous, direct. Zero slop: no marketing gradients, no emoji assistant, no fluff. |

First paint is **light**: the pre-paint script in `frontend/public/index.html` adds
`.light` unless the user has stored a choice (`localStorage.sutra_theme`).
`Coach.js`/`Header.js` keep it in sync and update the `theme-color` meta.

## 2. Design tokens

Defined as CSS variables in `frontend/src/index.css`. `:root` holds the **dark**
values (the pre-paint fallback); the `.light` class overrides them with the light
palette. Because the pre-paint script adds `.light` by default, the app presents as
**light-first**. Use the `var(--token)` values, never raw hex in components.

| Token | Light (default) | Dark |
|---|---|---|
| `--bg-primary` | `#FFFFFF` | `#000000` |
| `--bg-secondary` | `#F5F5F7` | `#1C1C1E` |
| `--bg-tertiary` | `#EFEFF1` | `#2C2C2E` |
| `--border` | `#D2D2D7` | `#38383A` |
| `--border-accent` | `#A1A1A6` | `#48484A` |
| `--text-primary` | `#1D1D1F` | `#FFFFFF` |
| `--text-secondary` | `#6E6E73` | `#EBEBF5` |
| `--text-muted` | `#86868B` | `#98989D` |
| `--accent` | `#007AFF` | `#0A84FF` |
| `--warning` | `#FF9500` | `#FF9F0A` |
| `--danger` | `#FF3B30` | `#FF453A` |
| `--success` | `#34C759` | `#30D158` |

- **Type:** platform system stack (`-apple-system` → SF Pro → Segoe UI → Roboto),
  one family everywhere, `-0.01em` tracking; mono = SF Mono/Menlo. Base size is
  user-scalable via `--sutra-font-scale` (rem-based, set on `<html>`).
- **Radius:** Apple-softer overrides — `rounded` 8 · `md` 10 · `lg` 12 · `xl` 14.
  `rounded-full`/`none` stay untouched.
- **Motion:** `gc-fade-up` 280ms, `gc-fade-in` 180ms; route transitions 150ms exit /
  210ms enter / 400ms move. **All motion respects `prefers-reduced-motion`.**

## 3. Screens & navigation

- **Routes (two only):** `/` = Coach (all screens ride `?panel=<key>`), `/settings`.
- **Screens** (`frontend/src/constants/screens.js`, shared by the desktop tab strip,
  mobile large-title bar, and `GoalMenu`): Overview (`/`), Goals, Today, Timeline,
  Memories, Sources, Curated for you.
- **Why `?panel=` not separate paths:** the pathname stays constant, so `Coach` never
  remounts — chat, dashboard data, and scroll survive every screen switch. Each
  switch is a **history push**, so system/browser back steps screen-by-screen.
- **Route transition** (`App.js` + `index.css` view-transition rules): `nav-forward`
  (into Settings — slides in from the right) / `nav-back` (returning — from the
  left). Direction is derived from the destination, so the back arrow, a menu item,
  and the browser's own back/forward buttons all animate correctly.

## 4. Mobile interaction contract

- **Back means "close this layer first."** Dialogs push a history sentinel via
  `useDialogBack`, so a back press closes the dialog; a second back leaves the app.
  Never let back exit mid-dialog.
- **Tap targets ≥ 44px** (`h-11`) on mobile, shrinking at `sm`.
- **Safe areas:** every edge respects `env(safe-area-inset-*)` (notch, home
  indicator); the chat FAB sits above it.
- **No webview tells:** kill the tap-highlight flash, `touch-action: manipulation`
  (no 300ms delay), and enforce the 16px form-control floor so iOS never auto-zooms.
- **Smoothness:** view transitions for route/screen changes, fades for content,
  skeleton shimmer for loads, no layout jump on panel switch.

**Mobile chrome:** iOS large-title bar — the active screen name *is* the dropdown
trigger (one affordance, not two) plus a back chevron when history exists. Desktop
uses the horizontal tab strip. Chat is a floating button opening a centered modal.

## 5. AI-slop floor

No generic centered layouts, no bubbly gradients, no emoji assistant icons, no
motivational fluff. Hairline 1px borders, deliberate density, honest voice. Every
interactive/critical element carries a unique `data-testid`. Meet WCAG 2.1 AA
(keyboard, screen reader, contrast, reduced motion).
