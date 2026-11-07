import { useId } from 'react'
import { Vibrate } from 'lucide-react'
import { Action } from '../hud/Action.tsx'
import { OptionGroup } from '../hud/OptionGroup.tsx'
import { SettingRow } from '../hud/SettingRow.tsx'
import { SliderControl } from '../hud/SliderControl.tsx'
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
    <div className="flex flex-col">
      {SLIDERS.map(({ field, label, about, format }) => {
        const range = TUNING_RANGES[field]
        return (
          <SettingRow
            key={field}
            label={label}
            detail={about}
            detailId={`${id}-${field}-about`}
            changed={tuning[field] !== DEFAULT_TUNING[field]}
          >
            <SliderControl
              label={label}
              describedBy={`${id}-${field}-about`}
              min={range.min}
              max={range.max}
              step={range.step}
              value={tuning[field]}
              reading={format(tuning[field])}
              onChange={(next) => set(field, next)}
            />
          </SettingRow>
        )
      })}
      <SwitchRow
        divided
        label="Invert look"
        detail="Stick back looks up."
        changed={tuning.invertLook !== DEFAULT_TUNING.invertLook}
        on={tuning.invertLook}
        onChange={(on) => set('invertLook', on)}
      />
      <SwitchRow
        divided
        label="Invert pitch"
        detail="Stick back lifts the nose, as in an aircraft."
        changed={tuning.invertPitch !== DEFAULT_TUNING.invertPitch}
        on={tuning.invertPitch}
        onChange={(on) => set('invertPitch', on)}
      />
      <SwitchRow
        divided
        label="Vibration"
        detail="The drive, and the acts that change the ship."
        changed={tuning.vibration !== DEFAULT_TUNING.vibration}
        on={tuning.vibration}
        onChange={(on) => set('vibration', on)}
      />
      {/* Its own row rather than a button inside the switch's: the switch
          row is a `<label>`, and a second control inside a label is content
          the element does not allow. */}
      <SettingRow
        label="Test vibration"
        detail={
          rumbles
            ? 'A short rumble at the strength the drive uses.'
            : 'The pad in hand has no motors, or none is connected.'
        }
      >
        <Action
          icon={Vibrate}
          label="Test"
          title="Rumble the controller for a moment"
          disabled={!tuning.vibration || !rumbles}
          onClick={() => store.pad?.rumble(0.8, 0.6, 300)}
        />
      </SettingRow>
      <SettingRow
        label="Button prompts"
        detail="Whose glyphs the interface draws. Automatic follows the pad in hand."
        changed={tuning.prompts !== DEFAULT_TUNING.prompts}
      >
        <OptionGroup
          label="Button prompts"
          value={tuning.prompts}
          values={PAD_PROMPTS}
          labels={PROMPT_LABELS}
          onChange={(prompts) => set('prompts', prompts)}
        />
      </SettingRow>
    </div>
  )
}
