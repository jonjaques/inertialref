import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

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
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
