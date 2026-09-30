import type { ClerkProviderProps } from '@clerk/react'
import { FOCUS_RING } from '../hud/focus.ts'

/*
 * Clerk's components, in this system's material.
 *
 * Clerk draws its own UI — sign-in, the profile, the badge's popover — from a
 * script it loads at runtime, and out of the box that is a white card with a
 * filled button. Over a starfield it is the brightest thing on screen by an
 * order of magnitude, which is the fault `DESIGN.md` names in the registry
 * tooltip, at page scale.
 *
 * The variables carry the palette: `slate-950` ground, `slate-200` ink,
 * `sky` accent, Plex Sans, the 0.5 rem radius. The elements carry what a
 * variable cannot say: **the primary button is a wash, not a fill** — the
 * accent as material, the rule every control in `hud/Action.tsx` follows.
 * Clerk's is a solid `colorPrimary` block with a gradient sheen on `::after`,
 * both removed.
 *
 * Clerk's card stays here, because its modal needs one: inside a mode the
 * modal is the only ground between the form and a sunlit planet. The account
 * pages take it away (`PAGE_ELEMENTS`), where the menu's gradient already is
 * the ground and a card on it is a box drawn around a column of type.
 *
 * `cssLayerName` is what lets any of the element classes win. Clerk injects
 * its styles unlayered, and an unlayered rule beats every layered one
 * regardless of specificity — so without it a Tailwind utility passed here is
 * silently outranked. `index.css` declares the `clerk` layer below
 * `utilities`.
 *
 * **No logo of Clerk's own.** The application logo in the dashboard is there
 * for the emails and the hosted pages, and Clerk's components draw it too
 * unless told not to: a second mark under the page's `Logomark`, and in the
 * modal a plain link to the dashboard's Home URL, which reloads the document
 * and ends the mode it was opened over. The modal's heading names the product.
 *
 * **The CAPTCHA is dark.** Its theme defaults to `auto`, which follows the
 * system rather than the page, so on a light-mode machine the sign-up
 * challenge is a white Turnstile box on the slate-950 ground.
 */
export const APPEARANCE = {
  cssLayerName: 'clerk',
  options: { logoPlacement: 'none' },
  captcha: { theme: 'dark' },
  variables: {
    colorPrimary: '#38bdf8', // sky-400
    colorPrimaryForeground: '#e0f2fe', // sky-100
    colorBackground: '#020617', // slate-950
    colorForeground: '#e2e8f0', // slate-200
    colorMutedForeground: '#94a3b8', // slate-400
    colorMuted: '#0f172a', // slate-900
    colorNeutral: '#cbd5e1', // slate-300 — Clerk derives its hairlines from it
    colorInput: '#0f172a', // slate-900
    colorInputForeground: '#e2e8f0', // slate-200
    colorBorder: '#334155', // slate-700
    colorRing: '#38bdf8', // sky-400, the focus ring everywhere else
    colorDanger: '#fda4af', // rose-300, the error ink `AuthCallbackPage` uses
    colorShadow: '#000000',
    colorModalBackdrop: 'rgb(2 6 23 / 0.7)', // the dialog scrim
    fontFamily: 'var(--font-sans)',
    fontFamilyButtons: 'var(--font-sans)',
    borderRadius: '0.5rem',
  },
  elements: {
    cardBox: 'border border-slate-700/60 shadow-xl shadow-black/50',
    formButtonPrimary: `rounded border border-sky-500/50 bg-sky-500/15 bg-none text-sky-200 shadow-none after:hidden hover:border-sky-400 hover:bg-sky-500/25 ${FOCUS_RING}`,
    userButtonPopoverCard: 'border border-slate-700/60 shadow-xl',
  },
} as const satisfies ClerkProviderProps['appearance']

/** Clerk's card, removed, for a component that is the body of an account page. */
export const PAGE_ELEMENTS = {
  rootBox: 'w-full',
  cardBox: 'w-full max-w-none border-0 shadow-none',
  card: 'bg-transparent px-0 py-2 shadow-none',
  footer: 'bg-none bg-transparent',
} as const
