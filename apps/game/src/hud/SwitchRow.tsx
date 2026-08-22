import { useId } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { releaseFocus } from './focus.ts'

/*
 * A labelled on/off row.
 *
 * One definition for what used to be two: `GraphicsPanel` drew a bordered row
 * with the word `on`/`off` at the end, and the planetarium's view panel drew a
 * borderless one with an eye that opened and closed. They were the same
 * control, they disagreed about everything visible, and neither was a switch —
 * both were `<button aria-pressed>`, which a screen reader announces as a
 * toggle button rather than as something with an on state.
 *
 * Radix's `Switch` is the state; what it does not carry is that a *pointer*
 * click in this overlay has to hand focus back to the flight loop. See
 * `releaseFocus`, and `useShipControls`' `isOverlayControl` for why a
 * keyboard activation deliberately keeps it.
 *
 * The whole row is the target, through a real `<label htmlFor>`: at 10 px a
 * switch alone is a 32×18 hit box beside forty characters of text that look
 * exactly as clickable and were not.
 */

export function SwitchRow({
  label,
  detail,
  icon: Icon,
  on,
  onChange,
  bordered = false,
}: {
  label: string
  /** The half that explains it. Truncates — it is the expendable one. */
  detail?: string
  icon?: LucideIcon
  on: boolean
  onChange: (on: boolean) => void
  /** A framed row, for panels that are a list of switches and nothing else. */
  bordered?: boolean
}) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      title={detail}
      className={`flex min-h-6 cursor-pointer items-center gap-2 rounded py-1 transition-colors ${
        bordered
          ? 'border border-slate-800/80 bg-slate-900/40 px-2 hover:border-sky-500/40'
          : 'px-1 hover:text-slate-200'
      }`}
    >
      {Icon !== undefined && (
        <Icon
          aria-hidden
          className={`size-3.5 shrink-0 ${on ? 'text-sky-300' : 'text-slate-400'}`}
        />
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={`shrink-0 ${on ? 'text-sky-200' : 'text-slate-300'}`}>
          {label}
        </span>
        {detail !== undefined && (
          <span className="min-w-0 truncate text-slate-400">{detail}</span>
        )}
      </span>
      <Switch
        id={id}
        size="sm"
        checked={on}
        onCheckedChange={onChange}
        onClick={releaseFocus}
        className="shrink-0"
      />
    </label>
  )
}
