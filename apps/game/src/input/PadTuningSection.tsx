import { useId } from 'react'
import { Vibrate } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { Action } from '../hud/Action.tsx'
import { releaseFocus } from '../hud/focus.ts'
import { OptionGroup } from '../hud/OptionGroup.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import {
  CONTROLS_PAD_TUNING,
  usePersistentState,
} from '../state/preferences.ts'
import {
  DEFAULT_TUNING,
  PAD_PROMPTS,
  type PadTuning,
  TUNING_RANGES,
} from './padTuning.ts'
import { useKeymap } from './useKeymap.ts'

/** The three sliders, each a label, a reading and a travel. */
const SLIDERS = [
  {
    field: 'deadzone',
    label: 'Deadzone',
    about:
      'How far a stick moves before it counts. Raise it if the ship turns on its own.',
    format: (value: number) => `${Math.round(value * 100)}%`,
  },
  {
    field: 'curve',
    label: 'Response curve',
    about:
      'How much of the stick’s throw is spent on fine control. One is linear.',
    format: (value: number) => value.toFixed(1),
  },
  {
    field: 'lookSpeed',
    label: 'Look speed',
    about:
      'How fast a stick turns a camera at full throw. It follows the lens, so a long lens turns slower.',
    format: (value: number) => `${value.toFixed(2)}×`,
  },
] as const

const PROMPT_LABELS = {
  auto: 'automatic',
  dualsense: 'PlayStation',
  xbox: 'Xbox',
  switch: 'Nintendo',
} as const

/**
 * How the pad feels, and whose glyphs it shows.
 *
 * Every one of these is in Xbox's accessibility guideline 107 for a reason
 * that is about hands rather than taste: a worn stick needs a larger deadzone,
 * a tremor wants a flatter curve, and an invert is a habit nobody should be
 * asked to unlearn. Saved as one preference, so an export carries the feel of
 * the pad along with its bindings.
 */
export function PadTuningSection({
  rumbles,
}: {
  /**
   * Whether the pad in hand has motors, from the page's live reading.
   *
   * A prop rather than a read of `store.pad.state` here: that is a mutable
   * port nothing re-renders this for, and a pad that connects is counted
   * before its first poll fills the state — so a read on the render the count
   * caused saw no pad, and the test button stayed disabled with one in hand.
   */
  readonly rumbles: boolean
}) {
  const [tuning, setTuning] = usePersistentState(CONTROLS_PAD_TUNING)
  const store = useKeymap()
  const id = useId()
  const set = <K extends keyof PadTuning>(field: K, value: PadTuning[K]) =>
    setTuning((held) => ({ ...held, [field]: value }))

  return (
    <div className="flex flex-col gap-2">
      {SLIDERS.map(({ field, label, about, format }) => {
        const range = TUNING_RANGES[field]
        return (
          <div key={field} className="flex flex-col">
            <div className="flex items-baseline justify-between gap-3">
              <span id={`${id}-${field}`} className="type-ui text-slate-400">
                {label}
              </span>
              <span className="type-readout text-slate-300">
                {format(tuning[field])}
              </span>
              <span id={`${id}-${field}-about`} hidden>
                {about}
              </span>
            </div>
            <Slider
              min={range.min}
              max={range.max}
              step={range.step}
              value={[tuning[field]]}
              aria-labelledby={`${id}-${field}`}
              aria-describedby={`${id}-${field}-about`}
              aria-valuetext={format(tuning[field])}
              onValueChange={([next]) => {
                if (next !== undefined) set(field, next)
              }}
              onClick={releaseFocus}
              className="min-w-0 flex-1 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
            />
          </div>
        )
      })}
      <SwitchRow
        label="Invert look"
        detail="stick back looks up"
        on={tuning.invertLook}
        onChange={(on) => set('invertLook', on)}
      />
      <SwitchRow
        label="Invert pitch"
        detail="stick back lifts the nose, as in an aircraft"
        on={tuning.invertPitch}
        onChange={(on) => set('invertPitch', on)}
      />
      <SwitchRow
        label="Vibration"
        detail="the drive, and the acts that change the ship"
        on={tuning.vibration}
        onChange={(on) => set('vibration', on)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="type-ui text-slate-400">Button prompts</span>
        <OptionGroup
          label="Button prompts"
          value={tuning.prompts}
          values={PAD_PROMPTS}
          labels={PROMPT_LABELS}
          onChange={(prompts) => set('prompts', prompts)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Action
          icon={Vibrate}
          label="Test vibration"
          title="Rumble the controller for a moment"
          disabled={!tuning.vibration || !rumbles}
          onClick={() => store.pad?.rumble(0.8, 0.6, 300)}
        />
        <Action
          label="Reset"
          title="The deadzone, curve, speed and switches back to their defaults"
          onClick={() => setTuning(DEFAULT_TUNING)}
        />
      </div>
    </div>
  )
}
