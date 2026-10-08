/**
 * Logo — Sutra brand mark (Option 17: Guru with Infinite Thread).
 *
 * Concept: A meditating guru silhouette channeling a continuous golden figure-8
 * (lemniscate) thread through mudra hands. Untangling life's chaotic threads
 * into an infinite, balanced continuum — "let's sort your life - together."
 *
 * Designed as a single 32x32 viewBox using currentColor so it adapts cleanly
 * to Tailwind accent and text colors across light and dark modes.
 */
export default function Logo({ className = "w-6 h-6" }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
      data-testid="logo-guru"
    >
      {/* Halo / wisdom aura */}
      <circle
        cx="16"
        cy="9.5"
        r="6.5"
        stroke="currentColor"
        strokeWidth="0.85"
        opacity="0.22"
      />
      <circle
        cx="16"
        cy="9.5"
        r="4.2"
        stroke="currentColor"
        strokeWidth="0.8"
        opacity="0.35"
      />

      {/* Head & topknot */}
      <circle cx="16" cy="9.6" r="2.2" fill="currentColor" />
      <circle cx="16" cy="6.6" r="1.1" fill="currentColor" />

      {/* Seated torso & mudra arms */}
      <path
        d="M 12 14.5 C 13.5 13, 18.5 13, 20 14.5 L 21 19.5 C 18 20.5, 14 20.5, 11 19.5 Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M 12 14.5 C 10.5 16.5, 9.8 18.5, 11.5 19"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M 20 14.5 C 21.5 16.5, 22.2 18.5, 20.5 19"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="11.5" cy="19" r="0.75" fill="currentColor" />
      <circle cx="20.5" cy="19" r="0.75" fill="currentColor" />

      {/* Lotus base (folded meditation legs) */}
      <path
        d="M 6.8 23.2 C 11 25.2, 21 25.2, 25.2 23.2 C 23.5 26.2, 8.5 26.2, 6.8 23.2 Z"
        fill="currentColor"
        opacity="0.8"
      />

      {/* The Infinite Thread (Lemniscate Figure-8 Loop) */}
      <path
        d="M 16 17.5 C 12.5 14, 6 14.5, 6 18.5 C 6 22.5, 12.5 23, 16 19.5 C 19.5 16, 26 15, 26 18.5 C 26 22, 19.5 22, 16 17.5 Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
