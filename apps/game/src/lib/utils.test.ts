import { describe, expect, it } from 'vitest'
import { cn } from './utils.ts'

/*
 * What the class merger has to know about the type steps.
 *
 * A registry control's base carries its own font classes — `Input` has
 * `text-base md:text-sm`, `ToggleGroupItem` has `text-sm font-medium`, `Badge`
 * has `text-xs` — and a `type-*` step at the call site is meant to replace
 * them, the way the `text-[11px]` overrides it superseded did. tailwind-merge
 * cannot know that a custom utility sets font metrics, and Tailwind v4 emits
 * multi-property `@utility` classes before the core single-property ones, so
 * an unmerged base class also wins the cascade: the regression this pins was
 * an address field at 16px beside 11px readouts. `lib/utils.ts` carries the
 * config; these are the compositions that shipped wrong.
 */
describe('cn and the type steps', () => {
  it('drops the Input base sizes for a readout field', () => {
    // The `md:` twin is load-bearing: a modified class only merges against an
    // equally modified one, so `type-readout` alone leaves `md:text-sm`
    // standing and the field is 14px on every desktop viewport.
    expect(
      cn('text-base md:text-sm px-3', 'type-readout md:type-readout'),
    ).toBe('px-3 type-readout md:type-readout')
  })

  it('drops the toggle base size and weight for a label step', () => {
    expect(cn('text-sm font-medium', 'type-label h-6')).toBe('type-label h-6')
  })

  it('drops the badge base size for a label step', () => {
    expect(cn('text-xs font-medium', 'type-label')).toBe('type-label')
  })

  it('lets a later explicit override beat the step', () => {
    // One-directional on purpose: `type-display` takes its size per site, and
    // a deliberate `font-normal` after a 600-weight step must survive.
    expect(cn('type-display', 'text-[2.75rem]')).toBe(
      'type-display text-[2.75rem]',
    )
    expect(cn('text-sm font-medium', 'type-label font-normal')).toBe(
      'type-label font-normal',
    )
  })
})
