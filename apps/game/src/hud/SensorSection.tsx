import { CAMERA_MODES, DEFAULT_SENSOR_SETTINGS } from '@inertialref/rendering'
import { Slider } from '@/components/ui/slider'
import { RENDER_SENSOR, usePersistentState } from '../state/preferences.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { Action } from './Action.tsx'
import { releaseFocus } from './focus.ts'
import { OptionGroup } from './OptionGroup.tsx'
import { Row } from './Row.tsx'
import { Section } from './Section.tsx'

/**
 * The selected camera mode and the controls that affect its picture.
 *
 * "Exposure" over the section, because that is what every row in it sets —
 * how the light that reaches the sensor becomes a picture — and it is the
 * word a photographer looks for first in a panel called Lens.
 *
 * **The comfort clamps are not here.** How fast Automatic adapts, and how far
 * it may swing bright or dark, are the protections `PRODUCT.md` promises
 * somebody for whom a star filling the frame after interstellar dark is
 * uncomfortable — a property of the person, kept in Settings › Display beside
 * the peak luminance cap, rather than of one photograph. What stays is what a
 * picture is: the mode, the compensation, the white balance.
 */
export function SensorSection() {
  const [settings, set] = usePersistentState(RENDER_SENSOR)
  const exposure = useEngine(
    useShallow((snapshot) =>
      snapshot.exposure === null
        ? null
        : {
            mode: snapshot.exposure.mode,
            processing: snapshot.exposure.processing,
            effectiveEV: snapshot.exposure.effectiveEV,
            gain: snapshot.exposure.gain,
            metered: snapshot.exposure.metered,
            override: snapshot.exposure.override,
            automaticAvailable: snapshot.exposure.automaticAvailable,
          },
    ),
  )
  const unavailable =
    settings.mode === 'automatic' && exposure?.automaticAvailable === false
  const adapting =
    settings.mode === 'automatic' &&
    !unavailable &&
    exposure?.override !== 'staging'
  const controls = [
    ...(adapting
      ? [
          {
            label: 'Exposure compensation',
            value: settings.compensation,
            min: -8,
            max: 8,
            step: 0.1,
            reading: `${settings.compensation >= 0 ? '+' : ''}${settings.compensation.toFixed(1)} EV`,
            change: (compensation: number) =>
              set((held) => ({ ...held, compensation })),
          },
        ]
      : []),
    {
      label: 'White balance',
      value: settings.balance,
      min: 2000,
      max: 12000,
      step: 50,
      reading: settings.balance === 6500 ? 'D65' : `${settings.balance} K`,
      change: (balance: number) => set((held) => ({ ...held, balance })),
    },
  ]
  return (
    <Section id="camera.sensor" title="Exposure" trailing={settings.mode}>
      <div className="flex flex-col gap-2">
        <span className="type-ui text-slate-300">Camera mode</span>
        <OptionGroup
          label="Camera mode"
          value={settings.mode}
          values={CAMERA_MODES}
          labels={{
            enhanced: 'Enhanced',
            automatic: 'Automatic',
            manual: 'Manual',
          }}
          onChange={(mode) => set((held) => ({ ...held, mode }))}
          className="w-full [&>*]:flex-1"
        />
        <p className="type-ui text-pretty text-slate-400">
          {settings.mode === 'enhanced'
            ? 'HDR composite balances bright worlds, stars and the Milky Way in one view.'
            : settings.mode === 'automatic'
              ? 'One photographic exposure adapts to the scene within your limits. Set the rate to zero to hold it.'
              : 'Aperture, shutter and ISO set one photographic exposure. Bright worlds and faint stars compete for it.'}
        </p>
      </div>
      {unavailable && (
        <div className="flex flex-col items-start gap-2">
          <p className="type-ui text-pretty text-amber-300" role="status">
            Automatic needs WebGPU. This view uses the manual lens exposure.
          </p>
          <Action
            label="Use manual"
            onClick={() => set((held) => ({ ...held, mode: 'manual' }))}
          />
        </div>
      )}
      {exposure?.override === 'staging' && (
        <p className="type-ui text-pretty text-slate-300">
          Authored exposure is active. Your camera mode resumes when it ends.
        </p>
      )}
      <Row
        label={exposure?.processing === 'enhanced' ? 'Processing' : 'Exposure'}
        value={
          exposure === null
            ? 'Starting'
            : exposure.processing === 'enhanced'
              ? 'HDR composite'
              : `EV ${exposure.effectiveEV.toFixed(1)} · ${exposure.override === 'staging' ? 'Authored' : exposure.mode === 'manual' ? 'Lens' : settings.rate === 0 ? 'Held' : exposure.metered ? 'Metered' : 'Calibrating'}`
        }
      />
      {exposure?.mode === 'automatic' && exposure.override === null && (
        <Row
          label="Gain over lens"
          value={`${exposure.gain.toPrecision(3)}×`}
        />
      )}
      {controls.map((control) => (
        <div key={control.label}>
          <Row label={control.label} value={control.reading} />
          <Slider
            min={control.min}
            max={control.max}
            step={control.step}
            value={[control.value]}
            aria-label={control.label}
            aria-valuetext={control.reading}
            onValueChange={([value]) => {
              if (value !== undefined) control.change(value)
            }}
            onClick={releaseFocus}
            className="min-w-0 py-2.5 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
          />
        </div>
      ))}
      <div className="flex justify-end">
        <Action
          label="Reset camera mode"
          // The photograph's settings, not the person's: the peak and the
          // comfort clamps are Settings' and stay as they were.
          onClick={() =>
            set((held) => ({
              ...DEFAULT_SENSOR_SETTINGS,
              peak: held.peak,
              rate: held.rate,
              range: held.range,
            }))
          }
        />
      </div>
    </Section>
  )
}
