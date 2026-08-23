import * as React from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

/*
 * Registry component, re-tuned to this system. `DESIGN.md` § Registry
 * Components listed this file as the one that shipped visibly wrong, and it
 * named both faults:
 *
 *   1. `bg-foreground` on `text-background` — an *inverted* chip, which in a
 *      one-palette dark interface is a white card appearing over a starfield.
 *      It is the brightest rectangle in the build and it is triggered by the
 *      pointer resting anywhere near the menu.
 *   2. The portal lands on `document.body`, which is outside `.hud-layer` and
 *      therefore outside `dynamic-range-limit: standard` — so on the extended
 *      path a tooltip over a sunlit limb is composited above diffuse white.
 *
 * Both are fixed here rather than at the call sites, because a `className` on
 * every `TooltipContent` in the codebase is the drift this file exists to stop.
 * `shadcn add tooltip` would overwrite it; that is the trade the registry
 * always makes and `DESIGN.md` says to take it.
 */

/**
 * 350ms rather than the registry's 0.
 *
 * A tooltip that appears the instant a pointer touches a control is not a hint,
 * it is a popover following the mouse: crossing the seven glyphs of the IR menu
 * on the way to a panel fired seven of them. The delay is the difference
 * between "I paused on this, tell me what it is" and "I moved past it".
 */
const HINT_DELAY_MS = 350

function TooltipProvider({
  delayDuration = HINT_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal container={hudLayer()}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          /*
           * The panel material at chip scale, and nothing else on it. No arrow:
           * a 10px diamond under a 20px box is a third shape to draw at a size
           * where it can only read as a smudge, and an 8px offset already says
           * which control the hint belongs to. The entrance is a 4px rise with
           * no zoom — the registry's `zoom-in-95` on something this small is a
           * flicker rather than a movement.
           */
          // `type-ui`, the prose sans, and not the mono the call sites used to
          // pass: a hint is a *sentence* — "everything within reach, nearest
          // first" — and the Instrument register is for values. Mono here was
          // the "monospace as a costume for technical" reflex.
          'type-ui pointer-events-none z-50 w-fit max-w-[18rem] rounded border border-slate-700/60 bg-slate-950/95 px-2.5 py-1.5 text-slate-200 text-balance shadow-lg shadow-black/50 backdrop-blur',
          'origin-(--radix-tooltip-content-transform-origin) animate-in fade-in-0 duration-150 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/**
 * Where a tooltip is portalled, and why it is not `document.body`.
 *
 * `.hud-layer` carries `dynamic-range-limit: standard` and that property
 * inherits, so anything drawn outside it is composited at whatever range the
 * canvas is running — which for a `backdrop-blur` chip over a star is twice
 * diffuse white. Read per render rather than held: `App` owns the layer for the
 * life of the session, but the element is replaced whenever the tree remounts,
 * and a stale node is a tooltip nobody can see. `null` is a legal container and
 * means the body, which is the right answer for a boot-time failure panel that
 * has no layer to sit in.
 */
const hudLayer = (): HTMLElement | null =>
  typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLElement>('.hud-layer')

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
