/**
 * Whether the "Add what you already have" explainer has been shown once, so the
 * first goal gets the full version (the four kinds of source) and every goal
 * after it gets the one-line version.
 *
 * Stored in localStorage so it survives reloads, with an in-memory fallback for
 * private windows where storage throws — the same shape as lib/scratchIntro.
 */
export const SOURCES_EXPLAINER_KEY = "sutra.sourcesExplainerSeen";
const KEY = SOURCES_EXPLAINER_KEY;

/**
 * The link guidance the founder asked for: a pasted URL only helps as much as
 * the user says what to take from it, so the explainer and the URL field both
 * carry the same instruction rather than leaving the coach to guess.
 */
export const LINK_EXPLAINER_LINE =
  "Pasting a link? Tell the coach what to take from it, like 'the skills this job asks for'. Or paste the page's text yourself.";

/** The short version, shown next to whichever field takes a URL. */
export const LINK_INPUT_HINT = "Tell the coach what to take from this link.";

let memory = false;

export function hasSeenSourcesExplainer() {
  try {
    return localStorage.getItem(KEY) === "1" || memory;
  } catch {
    return memory;
  }
}

export function markSourcesExplainerSeen() {
  memory = true;
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* storage blocked: the in-memory flag still holds for this session */
  }
}
