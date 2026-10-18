'use client'

import * as React from 'react'
import { type VariantProps } from 'class-variance-authority'
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { FOCUS_RING_OVER_INLINE } from '@/hud/focus'
import { toggleVariants } from '@/components/ui/toggle'

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    spacing?: number
  }
>({
  size: 'default',
  variant: 'default',
  spacing: 0,
})

/*
 * The root is a tab stop, and it has to draw when it holds focus.
 *
 * Radix's roving focus makes the root `tabindex="0"` until an item has been
 * focused: no item is a tab stop before then, so the root is what Tab lands on,
 * and it forwards focus to the pressed item on a keyboard entry. If it is left
 * holding focus — a programmatic `focus()`, an entry the forward does not
 * answer — it is a stop that draws nothing, and Tab looks to have done nothing.
 * So it carries `FOCUS_RING_OVER_INLINE` (`hud/focus.ts`), the hairline
 * marked important, because Radix writes `outline: none` inline on this
 * element and an inline style beats any class.
 */
function ToggleGroup({
  className,
  variant,
  size,
  spacing = 0,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants> & {
    spacing?: number
  }) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-spacing={spacing}
      style={{ '--gap': spacing } as React.CSSProperties}
      className={cn(
        `group/toggle-group flex w-fit items-center gap-[--spacing(var(--gap))] rounded-md ${FOCUS_RING_OVER_INLINE} data-[spacing=default]:data-[variant=outline]:shadow-xs`,
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size, spacing }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> &
  VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-spacing={context.spacing}
      className={cn(
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        'w-auto min-w-0 shrink-0 px-3 focus:z-10 focus-visible:z-10',
        'data-[spacing=0]:rounded-none data-[spacing=0]:shadow-none data-[spacing=0]:first:rounded-l-md data-[spacing=0]:last:rounded-r-md data-[spacing=0]:data-[variant=outline]:border-l-0 data-[spacing=0]:data-[variant=outline]:first:border-l',
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem }
