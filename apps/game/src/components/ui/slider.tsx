'use client'

import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

/*
 * The name and the value text belong on the thumb.
 *
 * `role="slider"` is the thumb, not the root, and Radix's `Root` spreads an
 * `aria-label`, an `aria-labelledby` or an `aria-valuetext` onto its own span
 * — an element no reader focuses, while the thumb it does focus announces
 * "slider" and a raw scrub index. So the name, the description and the value
 * text go to the thumb. Only for a single thumb: a range has two, Radix names
 * those "Minimum" and "Maximum" itself, and the name stays on the root as the
 * group's.
 *
 * WCAG 2.2 SC 2.5.8: the thumb draws at 14×14 and measures there, under the
 * 24×24 minimum. It takes the clause's **spacing** exception — a 24px circle on
 * the thumb meets no other target, because every slider here is alone on its
 * row with its label on the line above — and the **equivalent** one besides:
 * the root is a pointer target for the same function, padded by the call site
 * to 24px of height across the whole track.
 */
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  'aria-label': label,
  'aria-labelledby': labeledBy,
  'aria-describedby': describedBy,
  'aria-valuetext': valueText,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max],
  )
  const single = _values.length === 1

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      aria-label={single ? undefined : label}
      aria-labelledby={single ? undefined : labeledBy}
      aria-describedby={single ? undefined : describedBy}
      aria-valuetext={single ? undefined : valueText}
      className={cn(
        'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          'relative grow overflow-hidden rounded-full bg-muted data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5',
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            'absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full',
          )}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          aria-label={single ? label : undefined}
          aria-labelledby={single ? labeledBy : undefined}
          aria-describedby={single ? describedBy : undefined}
          aria-valuetext={single ? valueText : undefined}
          className="block size-4 shrink-0 rounded-full border border-primary bg-white shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
