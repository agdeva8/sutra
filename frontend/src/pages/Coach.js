import { useEffect, useState, useCallback, useRef, lazy, Suspense } from "react";
import { toast } from "sonner";
import { MessageSquare, Plus, Sparkles, ChevronLeft } from "lucide-react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { SCREENS, SCREEN_BY_KEY, screenKeyFromSearch, searchForScreen } from "../constants/screens";
import Header from "../components/Header";
import GoalMenu from "../components/GoalMenu";
import TrackingDashboard from "../components/TrackingDashboard";
// The four panel views are all gated behind `panelView`, so exactly one is
// mounted at a time and none of them are on the first-paint path — the
// default view renders TrackingDashboard alone. Importing them statically
// shipped 155 kB of source (Timeline is 103 kB of that) into the initial
// bundle regardless. Splitting each into its own chunk means the bundle
// fetches a panel only when the user actually opens that tab. The modals
// below stay eager on purpose: a dialog has to appear the instant it's
// tapped, and a chunk fetch there would read as lag.
const Timeline = lazy(() => import("../components/Timeline"));
const Memories = lazy(() => import("../components/Memories"));
const Sources = lazy(() => import("../components/Sources"));
const Today = lazy(() => import("../components/Today"));
const Overview = lazy(() => import("../components/Overview"));
const Motivation = lazy(() => import("../components/Motivation"));

// Fallback while a panel's chunk fetches. Declared at module level rather
// than inside Coach — a component defined during render is a new component
// type on every render and would remount the subtree. role="status" so the
// wait is announced instead of the panel silently not appearing.
function PanelSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading panel" className="flex flex-col gap-4">
      <div className="gc-skeleton h-7 w-44 rounded" />
      <div className="gc-skeleton h-36 w-full rounded" />
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <div className="gc-skeleton h-28 rounded" />
        <div className="gc-skeleton h-28 rounded" />
      </div>
    </div>
  );
}
import HonestyAuditView from "../components/HonestyAuditView";
import SignInModal from "../components/SignInModal";
import AboutModal from "../components/AboutModal";
import ActionPromptModal, { FRAMES } from "../components/ActionPromptModal";
import SourceActionDialog from "../components/SourceActionDialog";
import GoalBoundaryConfirmDialog from "../components/GoalBoundaryConfirmDialog";
import FocusedTaskChatDialog from "../components/FocusedTaskChatDialog";
import ReplanSuggestions from "../components/ReplanSuggestions";
import ReplanToast from "../components/ReplanToast";
import ChatModal from "../components/ChatModal";
import WelcomeToast from "../components/WelcomeToast";

/**
 * Coach (post Slice-2)
 * -------------------
 * Layout philosophy change: the persistent chat panel on the left is
 * gone. The whole page is the right-side dashboard by default (Goals /
 * Calendar / Timeline tabs). The chat opens in a centered modal
 * whenever the user taps "Chat with coach" in the header, the
 * floating bottom-right chat button, or one of the storyboard
 * scenarios. State lives inside ChatModal so re-opening the modal
 * shows the prior conversation; Coach.js only owns the dashboard
 * state + the chat-open flag.
 */
/**
 * General-chat navigator registry — the destinations a "Take me there"
 * suggestion can point at. This is the lightweight map the coach's
 * `navigate` action resolves through: target → panel + optional action.
 * Keep it small and explicit; add a target here AND to the SYSTEM_PROMPT's
 * allowed `navigate` targets when you add a surface.
 */
const NAV_TARGETS = {
  add_goal: { panel: "state", openAddGoal: true },
  drop_goal: { panel: "state" },
  pause_goal: { panel: "state" },
  edit_goal: { panel: "state" },
  commitments: { panel: "today" },
  today: { panel: "today" },
  timeline: { panel: "timeline" },
  sources: { panel: "sources" },
  memories: { panel: "memories" },
  motivation: { panel: "motivation" },
};

export default function Coach() {
  const { user, setUser, loading, logout } = useAuth();
  const isGuest = !!user?.is_guest;

  const [state, setState] = useState(null);
  const [stateError, setStateError] = useState(null);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("sutra_theme") || "light",
  );
  const [auditOpen, setAuditOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  // Dialog closer stack — registered by nested dialogs (e.g. the
  // AddGoalDialog rendered inside TrackingDashboard) so the global
  // back button can peel layers in the order they opened. The top of
  // the stack is the most recently registered closer.
  const closerStackRef = useRef([]);
  const pushCloser = useCallback((fn) => {
    closerStackRef.current.push(fn);
    return () => {
      const i = closerStackRef.current.lastIndexOf(fn);
      if (i >= 0) closerStackRef.current.splice(i, 1);
    };
  }, []);
  const popCloser = useCallback(() => {
    const stack = closerStackRef.current;
    while (stack.length > 0) {
      const fn = stack.pop();
      try { fn?.(); return true; } catch { /* try the next one */ }
    }
    return false;
  }, []);
  const [actionModal, setActionModal] = useState(null);
  // Focused-task dialog (per-action isolated chat). When set, opens
  // a fresh chat scoped to a single goal-edit / pause / drop /
  // add_step / source-replan action. The global ChatModal stays for
  // the generic "Chat with coach" entry points (header, FAB,
  // storyboard).
  const [focusedTask, setFocusedTask] = useState(null);
  // Default mode is "coach may ask" — the coach asks the user
  // questions before proposing. The user has to explicitly flip the
  // switch to "auto" before the coach writes to state without a
  // follow-up. This is closer to a coaching relationship than the
  // old "always emit a tool call" default.
  const [autoAnswer, setAutoAnswerRaw] = useState(false);
  const [grillMe, setGrillMeRaw] = useState(false);
  const [sourceDialogMode, setSourceDialogMode] = useState(null);
  const [sourceDialogSource, setSourceDialogSource] = useState(null);
  const [boundaryConfirm, setBoundaryConfirm] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatPrefill, setChatPrefill] = useState("");
  // Iteration 5 — optional scoped chat context (set by Today Timetable /
  // Timeline / focused-task CTAs). Null = generic "Chat with your coach".
  const [chatScope, setChatScope] = useState(null);
  // General-chat navigator — set when the coach suggests "Take me there →
  // Add goal". TrackingDashboard opens the Add Goal dialog on arrival and
  // calls `onAutoOpenAddGoalHandled` to clear it.
  const [pendingAddGoal, setPendingAddGoal] = useState(false);
  const [devLoginAvailable, setDevLoginAvailable] = useState(false);

  const setAutoAnswer = (v) => {
    const next = typeof v === "function" ? v(autoAnswer) : v;
    setAutoAnswerRaw(next);
    if (next) setGrillMeRaw(false);
  };
  const setGrillMe = (v) => {
    const next = typeof v === "function" ? v(grillMe) : v;
    setGrillMeRaw(next);
    if (next) setAutoAnswerRaw(false);
  };

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    localStorage.setItem("sutra_theme", theme);
  }, [theme]);

  // Probe /api/auth/dev-login once on mount to learn whether the
  // server-side dev bypass is on. 200 = enabled (persona menu and
  // SignInModal's "Continue as Dev User" CTA both render); 404 =
  // disabled (they stay hidden). The shared flag prevents every
  // component from probing on its own.
  useEffect(() => {
    let cancelled = false
    import("../lib/api").then(({ API }) => {
      fetch(`${API}/auth/dev-login?probe=1`, {
        method: "GET",
        credentials: "include",
      })
        .then((r) => {
          if (!cancelled) setDevLoginAvailable(r.status === 200)
        })
        .catch(() => {
          if (!cancelled) setDevLoginAvailable(false)
        })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const refreshState = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      setStateError(null);
      return next;
    } catch (e) {
      // B5#2 — offline / 5xx used to leave every panel on its
      // skeleton forever. Keep the error so the landing tab can
      // offer a retry instead.
      setStateError(e);
      return null;
    }
  }, []);

  useEffect(() => {
    if (loading || !user) return;
    refreshState();
  }, [loading, user, refreshState]);

  const doLogout = async () => {
    await logout();
    setState(null);
    window.location.href = "/";
  };

  const openSignIn = () => setSignInOpen(true);

  // Open the chat with a pre-filled question — used by Today Timetable's
  // "I can't do this" / "Break it down with coach" buttons and the
  // Timeline's per-tile CTAs. Accepts an optional scoped context
  // (scope/refId/kind/title/helperText) so the modal can show
  // "About: <subject>" and mint a per-entity conversation server-side.
  const openChatWith = (prefill, scoped = null) => {
    setChatPrefill(prefill || "");
    setChatScope(scoped);
    setChatOpen(true);
  };

  const openAction = (goal, type) =>
    setActionModal({ goalId: goal?.id || null, goalTitle: goal?.title || "", type });

  // When the user clicks "Ask the coach" inside ActionPromptModal,
  // open an ISOLATED focused-task chat (instead of the global
  // ChatModal). Pre-fills the input with the action message so the
  // user just hits Enter to send. The header reuses the frame's own
  // title (`Drop "X"?` / `Pause "X"?` / …) so the chat reads as the
  // continuation of the dialog, not a generic "focused task".
  const onGoalAction = (msg) => {
    const act = actionModal;
    setActionModal(null);
    const frameTitle =
      act && FRAMES[act.type || "edit"]
        ? FRAMES[act.type || "edit"].title(act.goalTitle)
        : `Add commitments for the "${act?.goalTitle || "goal"}" goal`;
    // Map the goal action to its real conversation kind so the follow-up
    // chat is NON-generic and drop/pause/edit-aware instead of a free-form
    // plan_day bucket (founder feedback: the drop flow opened a generic
    // chat). The server already supports these kinds (SCOPE_TO_KIND /
    // CONV_KINDS in chat/stream). `refId` is intentionally NOT passed — the
    // dialog mints a fresh per-open bucket so each drop/pause starts clean;
    // the goal identity travels via the intent title ("Drop \"X\"?").
    const ACTION_KIND = {
      drop: "drop_goal",
      pause: "edit_goal",
      edit: "edit_goal",
      add_step: "plan_day",
    };
    const kind = ACTION_KIND[act?.type] || "plan_day";
    // Plain-chat empty line per action — keeps the follow-up a simple
    // back-and-forth instead of the "About this / scoped" boilerplate.
    const ACTION_EMPTY_PROMPT = {
      drop: "Tell me why. If it makes sense, I'll drop it.",
      pause: "Tell me why you want to pause, and for how long.",
      edit: "What should change?",
      add_step: "What step should I add?",
    };
    setFocusedTask({
      title: frameTitle,
      // Deliberately no "This chat is scoped…" subtitle — plain chat.
      subtitle: "",
      emptyPrompt: ACTION_EMPTY_PROMPT[act?.type] || "Talk it through with me.",
      // Send the reason on open so the coach replies immediately.
      autoSend: true,
      // Drop flow: the coach proposes the drop with a deterministic impact
      // preview on the card; the user confirms it there (no silent apply).
      prefillMessage: msg,
      icon: Sparkles,
      // Spec §10.7 — focused-task chat runs in its own bucket; the dialog
      // mints the per-open refId. `scope` mirrors `kind` so any scope-based
      // lookup resolves consistently.
      scope: kind,
      kind,
    });
  };

  const handleBoundaryReplan = ({ goalIds }) => {
    const goalTitles = (state?.goals || [])
      .filter((g) => goalIds.includes(g.id))
      .map((g) => g.title);
    if (goalTitles.length === 0) return;
    const goalList = goalTitles.map((t) => `"${t}"`).join(", ");
    setFocusedTask({
      title:
        goalTitles.length === 1
          ? `Re-plan "${goalTitles[0]}"`
          : `Re-plan ${goalTitles.length} goals`,
      subtitle: `A source change affects ${goalList}. Ask the coach to re-plan.`,
      prefillMessage: `The source I just changed affects ${goalList}. Please re-plan.`,
      icon: Sparkles,
      // Spec §10.7 — replan runs as its own plan_day bucket; the
      // dialog mints the per-open refId.
      scope: "generic",
      kind: "plan_day",
    });
  };

  // Drop flow → opt-in re-plan. Opens the `review_progress` chat with a
  // prefilled instruction; the coach proposes date/scope changes the user
  // confirms through the normal proposal flow. Never auto-runs.
  const onRequestReplan = ({ goalTitle, freed }) => {
    setFocusedTask(null);
    openChatWith(
      `I dropped "${goalTitle}" and freed ${freed}h/week. Re-plan my remaining goals to use that capacity.`,
      {
        scope: "review_progress",
        kind: "review_progress",
        title: "Re-plan my remaining goals",
        helperText: `You freed ${freed}h/week by dropping "${goalTitle}". The coach will propose changes for you to confirm.`,
        autoSend: true,
      },
    );
  };

  const openReplanSuggestion = (suggestion) => {
    openChatWith(suggestion.prefill, {
      scope: "review_progress",
      kind: "review_progress",
      title: suggestion.goal_title
        ? `Re-plan: ${suggestion.goal_title}`
        : "Re-plan my goals",
      helperText: suggestion.message,
      autoSend: true,
    });
  };

  const uploadFile = async (file, goalId = "", options = {}) => {
    toast.message(`Uploading ${file.name}…`);
    try {
      // Capture the created source so callers (chat chips, AddGoalDialog)
      // can hold its real server id and delete it server-side on X.
      const source = await api.uploadSource(file, goalId, options);
      await refreshState();
      toast.success(`Added ${file.name} as a source`);
      return source;
    } catch (e) {
      toast.error(typeof e?.message === 'string' ? e.message : "Couldn't upload that file. Try again.");
      return null;
    }
  };

  const addLink = async (url, goalId = "", options = {}) => {
    if (!url) return null;
    try {
      const prevState = state;
      const source = await api.addLink({
        url,
        goal_id: goalId,
        temporary: options.temporary === true,
        ...(typeof options.text === "string" && options.text.trim() ? { text: options.text } : {}),
      });
      await refreshState();
      if (goalId && prevState?.goals) {
        const goal = prevState.goals.find((g) => g.id === goalId);
        if (goal) {
          setBoundaryConfirm({
            changeType: "added",
            sourceName: url,
            affectedGoals: [
              {
                id: goal.id,
                title: goal.title,
                reason:
                  "This link is now attached as a source — it may change what the goal is really about or which milestones still make sense.",
              },
            ],
          });
        }
      }
      toast.success("Link added as a source");
      return source;
    } catch (e) {
      toast.error(typeof e?.message === 'string' ? e.message : "Couldn't add the link. Try again.");
      return null;
    }
  };

  const deleteSource = async (id) => {
    try {
      const prevState = state;
      const deleted = (prevState?.sources || []).find((s) => s.id === id);
      await api.deleteSource(id);
      await refreshState();
      if (deleted?.goal_id && prevState?.goals) {
        const goal = prevState.goals.find((g) => g.id === deleted.goal_id);
        if (goal) {
          setBoundaryConfirm({
            changeType: "removed",
            sourceName: deleted.original_filename || deleted.url || "",
            affectedGoals: [
              {
                id: goal.id,
                title: goal.title,
                reason:
                  "This goal was using that source. The coach may want to revise the milestones or next action.",
              },
            ],
          });
        }
      }
    } catch {
      toast.error("Couldn't remove the source. Try again.");
    }
  };

  const openSourceLinkDialog = () => {
    setSourceDialogSource(null);
    setSourceDialogMode("link");
  };
  const closeSourceDialog = () => {
    setSourceDialogMode(null);
    setSourceDialogSource(null);
  };

  // Iteration 7 — the landing tab is always Goals. Earlier iterations
  // remembered the last-used tab in localStorage, but the founder
  // reported landing on Timeline every time and wanted Goals to be the
  // canonical landing tab on every fresh page load. The localStorage
  // save and read have both been removed.
  //
  // Wave B — the active screen now lives in the URL (`?panel=…`, see
  // constants/screens.js). It's derived, not stored: this component
  // never remounts across panel switches (pathname stays `/`), so chat,
  // dashboard data and this screen's scroll position all survive.
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const panelView = screenKeyFromSearch(searchParams.toString());
  const activeScreen = SCREEN_BY_KEY[panelView];

  // Push a screen onto history so browser/system back steps
  // screen-by-screen. Clicking the screen you're already on is a no-op —
  // otherwise every tab tap would stack a duplicate history entry.
  const goPanel = (key) => {
    if (key === panelView) return;
    setSearchParams(searchForScreen(key));
  };

  // Mobile back affordance: when ANY dialog is open, close the topmost
  // one first instead of walking history / exiting the app. The user
  // expects back to peel layers: dialog → scoped screen → home, not
  // jump straight out. (Founder feedback, Iteration 9+.)
  const isAnyDialogOpen =
    chatOpen ||
    focusedTask ||
    actionModal ||
    sourceDialogMode ||
    boundaryConfirm ||
    signInOpen ||
    auditOpen ||
    aboutOpen ||
    closerStackRef.current.length > 0;
  const closeTopmostDialog = () => {
    // The stack wins — it knows about nested dialogs (AddGoalDialog
    // owns the refine/reject modals and the parent dialog itself; the
    // topmost closer is whichever opened last).
    if (popCloser()) return true;
    if (chatOpen) { setChatOpen(false); setChatPrefill(""); setChatScope(null); return true; }
    if (focusedTask) { setFocusedTask(null); return true; }
    if (actionModal) { setActionModal(null); return true; }
    if (sourceDialogMode || sourceDialogSource) { closeSourceDialog(); return true; }
    if (boundaryConfirm) { setBoundaryConfirm(null); return true; }
    if (signInOpen) { setSignInOpen(false); return true; }
    if (auditOpen) { setAuditOpen(false); return true; }
    if (aboutOpen) { setAboutOpen(false); return true; }
    return false;
  };
  const canGoBack =
    isAnyDialogOpen ||
    location.key !== "default" ||
    panelView !== "home";
  const goBack = () => {
    if (closeTopmostDialog()) return;
    if (location.key !== "default") navigate(-1);
    else goPanel("home");
  };

  // "Take me there" — close the chat and route to the surface a `navigate`
  // suggestion points at. The general chat never applies edits itself.
  const onChatNavigate = (target) => {
    setChatOpen(false);
    setChatPrefill("");
    setChatScope(null);
    setFocusedTask(null);
    const nav = NAV_TARGETS[target];
    if (!nav) return;
    if (nav.openAddGoal) setPendingAddGoal(true);
    goPanel(nav.panel);
  };

  return (
    <div className="h-[100dvh] flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-hidden">
      <a
        href="#main"
        data-testid="skip-link"
        className="sr-only focus:not-sr-only focus:absolute focus:z-[70] focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:rounded focus:bg-[var(--accent)] focus:text-[var(--bg-primary)] focus:text-sm focus:font-medium"
      >
        Skip to content
      </a>
      <Header
        user={user}
        authLoading={loading}
        onOpenChat={() => setChatOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
        onSignIn={openSignIn}
        onLogout={doLogout}
        devLoginAvailable={devLoginAvailable}
        currentUserId={user?.user_id || user?.id}
      />

      {isGuest ? (
        <div
          data-testid="guest-banner"
          className="border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-4 sm:px-6 py-2 flex items-center gap-3 shrink-0"
        >          <span className="text-xs uppercase text-[var(--accent)]">
            preview
          </span>
          <span className="text-xs text-[var(--text-secondary)] flex-1">
            Sign in to keep this session and unlock every feature.
          </span>
          <button
            data-testid="guest-banner-signin"
            onClick={openSignIn}
            className="min-h-11 inline-flex items-center text-xs font-medium text-[var(--accent)] hover:underline shrink-0"
          >
            Sign in
          </button>
        </div>
      ) : loading ? (
        // B5#12 — reserve the banner's row while auth resolves so the
        // late guest banner doesn't push the page down (CLS).
        <div
          data-testid="guest-banner-reserve"
          aria-hidden="true"
          className="h-[61px] shrink-0 border-b border-transparent"
        />
      ) : null}

      <main id="main" tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto focus:outline-none">
        <div className="shrink-0 flex items-center sm:border-b sm:border-[var(--border)] px-4 sm:px-6 pt-2 bg-[color-mix(in_srgb,var(--bg-primary)_85%,transparent)] sticky top-0 z-10 backdrop-blur-md overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none]">
          {/* Mobile — an iOS large-title bar. The active screen name is
              the page title (via GoalMenu's large variant) and is itself
              the dropdown trigger — one affordance, not two. A back
              chevron appears when there's history to pop. */}
          <div className="sm:hidden flex items-center gap-1.5 min-w-0 w-full">
            {canGoBack && (
              <button
                data-testid="panel-back-button"
                onClick={goBack}
                aria-label="Back"
                title="Back"
                className="-ml-2 h-11 w-11 flex items-center justify-center text-[var(--accent)] hover:text-[var(--text-primary)] transition-colors shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              >
                <ChevronLeft className="w-5 h-5" aria-hidden="true" />
              </button>
            )}
            <GoalMenu large />
          </div>

          {/* Desktop — the horizontal strip stays, now route-driven:
              each tab is a real URL, and the active screen carries
              aria-current. Visually unchanged. */}
          <nav aria-label="Screens" className="hidden sm:flex items-center">
            {SCREENS.map((s) => {
              const Icon = s.Icon;
              const active = s.key === panelView;
              return (
                <Link
                  key={s.key}
                  to={s.to}
                  aria-current={active ? "page" : undefined}
                  data-testid={`panel-tab-${s.key}`}
                  className={`font-medium flex items-center gap-1.5 h-11 sm:h-9 px-3 text-xs whitespace-nowrap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                    active
                      ? "text-[var(--accent)] border-b-2 border-[var(--accent)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" /> {s.shortLabel || s.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="px-4 sm:px-6 py-6 max-w-[1400px] mx-auto w-full">
          <div className="mb-4">
            <ReplanSuggestions
              suggestions={state?.replan_suggestions || []}
              engine={state?.replan_engine}
              active={["state", "today", "timeline"].includes(panelView)}
              onReplan={openReplanSuggestion}
            />
          </div>
          <Suspense fallback={<PanelSkeleton />}>
            {panelView === "home" ? (
              <Overview
                state={state}
                onOpenChat={openChatWith}
                onOpenToday={() => goPanel("today")}
                onOpenGoals={() => goPanel("state")}
              />
            ) : panelView === "motivation" ? (
              <Motivation state={state} />
            ) : panelView === "state" ? (
              <TrackingDashboard
                state={state}
                loadError={stateError}
                onRetry={refreshState}
                onAction={(goal, type) => openAction(goal, type)}
                onUploadSource={uploadFile}
                onAddLink={addLink}
                onDeleteSource={deleteSource}
                onCreated={refreshState}
                onOpenChat={() => setChatOpen(true)}
                onOpenChatWith={openChatWith}
                onOpenToday={() => goPanel("today")}
                autoAnswer={autoAnswer}
                grillMe={grillMe}
                isGuest={isGuest}
                registerCloser={pushCloser}
                autoOpenAddGoal={pendingAddGoal}
                onAutoOpenAddGoalHandled={() => setPendingAddGoal(false)}
              />
            ) : panelView === "today" ? (
              <Today state={state} onChange={refreshState} onOpenChat={openChatWith} />
            ) : panelView === "timeline" ? (
              <Timeline
                state={state}
                onPrefill={() => setChatOpen(true)}
                onOpenChatWith={openChatWith}
                onChange={refreshState}
              />
            ) : panelView === "sources" ? (
              <Sources state={state} onChange={refreshState} />
            ) : (
              <Memories state={state} onChange={refreshState} />
            )}
          </Suspense>
        </div>
      </main>

      {/* Floating chat button — always visible, opens the centered modal. */}
      <button
        data-testid="fab-chat"
        onClick={() => setChatOpen(true)}
        title="Chat with your coach"
        aria-label="Chat with your coach"
        className="fixed right-[max(1.5rem,env(safe-area-inset-right))] bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-40 h-14 w-14 rounded-full bg-[var(--accent)] text-[var(--bg-primary)] shadow-2xl flex items-center justify-center hover:opacity-90 transition-opacity"
      >
        <MessageSquare className="w-6 h-6" />
      </button>

      <ChatModal
        open={chatOpen}
        onClose={() => { setChatOpen(false); setChatPrefill(""); setChatScope(null); }}
        user={user}
        setUser={setUser}
        autoAnswer={autoAnswer}
        setAutoAnswer={setAutoAnswer}
        grillMe={grillMe}
        setGrillMe={setGrillMe}
        onStateChange={(next) => setState(next)}
        onAction={(goal, type) => openAction(goal, type)}
        onNavigate={onChatNavigate}
        onUploadFile={uploadFile}
        onAddLink={addLink}
        onOpenSignIn={openSignIn}
        isGuest={isGuest}
        prefillMessage={chatPrefill}
        autoSend={chatScope?.autoSend || false}
        scope={chatScope?.scope}
        refId={chatScope?.refId}
        kind={chatScope?.kind}
        title={chatScope?.title}
        helperText={chatScope?.helperText}
      />

      <WelcomeToast user={user} state={state} signedIn={!isGuest} />
      <ReplanToast
        suggestions={state?.replan_suggestions || []}
        onReplan={openReplanSuggestion}
      />

      <HonestyAuditView open={auditOpen} onClose={() => setAuditOpen(false)} />
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <SignInModal open={signInOpen} onClose={() => setSignInOpen(false)} />
      <ActionPromptModal
        action={actionModal}
        onClose={() => setActionModal(null)}
        onSend={onGoalAction}
      />
      <SourceActionDialog
        open={!!sourceDialogMode}
        onClose={closeSourceDialog}
        mode={sourceDialogMode || "link"}
        source={sourceDialogSource}
        goalId=""
        onAddLink={addLink}
        onDeleteSource={deleteSource}
      />
      <GoalBoundaryConfirmDialog
        open={!!boundaryConfirm}
        onClose={() => setBoundaryConfirm(null)}
        changeType={boundaryConfirm?.changeType}
        sourceName={boundaryConfirm?.sourceName}
        affectedGoals={boundaryConfirm?.affectedGoals || []}
        onReplan={handleBoundaryReplan}
        onKeep={() => setBoundaryConfirm(null)}
      />
      <FocusedTaskChatDialog
        open={!!focusedTask}
        onClose={() => setFocusedTask(null)}
        title={focusedTask?.title}
        subtitle={focusedTask?.subtitle}
        emptyPrompt={focusedTask?.emptyPrompt}
        autoSend={focusedTask?.autoSend}
        onRequestReplan={onRequestReplan}
        prefillMessage={focusedTask?.prefillMessage}
        icon={focusedTask?.icon}
        user={user}
        isGuest={isGuest}
        autoAnswer={autoAnswer}
        grillMe={grillMe}
        setAutoAnswer={setAutoAnswer}
        setGrillMe={setGrillMe}
        onStateChange={(next) => setState(next)}
        onNavigate={onChatNavigate}
        onUploadFile={uploadFile}
        onAddLink={addLink}
        onOpenSignIn={openSignIn}
        scope={focusedTask?.scope}
        refId={focusedTask?.refId}
        kind={focusedTask?.kind}
        helperText={focusedTask?.helperText}
      />
    </div>
  );
}
