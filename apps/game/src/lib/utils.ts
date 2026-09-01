import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/*
 * shadcn/ui's class merger, at the path its registry hard-codes.
 *
 * Every component `pnpm dlx shadcn add` writes imports `cn` from `@/lib/utils`
 * by that exact string, so this file's location is fixed by the tool rather
 * than chosen. `clsx` resolves the conditionals; `twMerge` is the half that
 * matters — Tailwind emits utilities in a fixed order, not source order, so
 * `px-2` after `px-1.5` in a className is not reliably the winner and a
 * variant's padding could lose to the base's. `twMerge` drops the loser
 * outright instead of leaving the outcome to the stylesheet.
 */

/**
 * The ten type steps, declared as a class group so the merger can see them.
 *
 * `type-readout` on an `Input` is meant to *replace* the registry base's
 * `text-base md:text-sm`, exactly as the per-site `text-[11px]` overrides it
 * superseded used to — but tailwind-merge cannot know a custom utility sets
 * font metrics, so both survived the merge, and Tailwind v4 emits
 * multi-property `@utility` classes before the core single-property ones, so
 * the base won the cascade: the address field rendered 16px beside 11px
 * readouts and the toggle-group labels 14px/500 beside 11px/600. Declaring
 * the steps here removes the base classes at merge time, which is the one
 * place the fight can be settled for every registry control at once.
 *
 * The conflict is one-directional on purpose: a later `font-normal` or
 * `text-[2.75rem]` after a type step still wins, which is how the display
 * step takes its per-site size. One residue is not covered — a *modified*
 * base class (`md:text-sm`) only conflicts with an equally modified step, so
 * the two Inputs write `md:type-readout` beside `type-readout`.
 *
 * `apps/game/src/lib/utils.test.ts` pins all of this down.
 */
const TYPE_STEPS = [
  'type-display',
  'type-title',
  'type-heading',
  'type-label',
  'type-body',
  'type-ui',
  'type-readout',
  'type-figure',
  'type-stat',
  'type-micro',
]

// The generic registers `type` as an additional class-group id — without it
// the config's keys are typed against the built-in groups only.
const twMerge = extendTailwindMerge<'type'>({
  extend: {
    classGroups: { type: TYPE_STEPS },
    conflictingClassGroups: {
      type: [
        'font-size',
        'font-weight',
        'font-family',
        'font-stretch',
        'tracking',
        'leading',
        'text-transform',
        'fvn-spacing',
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
