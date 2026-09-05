import {
  DEFAULT_SENSOR_SETTINGS,
  RESPONSE_PRESETS,
  SENSOR_RESPONSES,
} from '@inertialref/rendering'
import { Slider } from '@/components/ui/slider'
import { RENDER_SENSOR, usePersistentState } from '../state/preferences.ts'
import { useEngine, useShallow } from '../state/engineStore.ts'
import { Action } from './Action.tsx'
import { releaseFocus } from './focus.ts'
import { Row } from './Row.tsx'
import { Section } from './Section.tsx'
import { SurfaceRow } from './SurfaceRow.tsx'

/** The declared processing and the comfort controls of the canopy. */
export function SensorSection() {
  const [settings, set] = usePersistentState(RENDER_SENSOR)
  // The reading is a fresh object every sample; select the two fields drawn
  // so an unchanged exposure does not re-render five sliders at sample rate.
  const exposure = useEngine(
    useShallow((snapshot) =>
      snapshot.exposure === null
        ? null
        : {
            adapted: snapshot.exposure.adapted,
            metered: snapshot.exposure.metered,
          },
    ),
  )
  return (
    <Section id="camera.sensor" title="Canopy" trailing={settings.response}>
      <SurfaceRow
        label="Response"
        detail="Direct uses the lens exposure; Composite selects the processing"
        value={settings.response}
        values={SENSOR_RESPONSES}
        onChange={(response) => set((held) => ({ ...held, response }))}
      />
      <SurfaceRow
        label="Rendering"
        detail="Natural keeps the production calibration; Neutral meters the scene and preserves hue"
        value={settings.curve}
        values={RESPONSE_PRESETS}
        onChange={(curve) => set((held) => ({ ...held, curve }))}
      />
      <Row
        label="Exposure"
        value={
          exposure === null
            ? 'Starting'
            : `EV ${exposure.adapted.toFixed(1)} · ${exposure.metered ? 'Metered' : 'Fixed'}`
        }
      />
      <Row
        label="Filter"
        value={`Broadband · ${settings.balance === 6500 ? 'D65' : `${settings.balance} K`}`}
      />
      {[
        {
          label: 'Adaptation rate',
          value: settings.rate,
          min: 0,
          max: 4,
          step: 0.1,
          reading:
            settings.rate === 0 ? 'Hold' : `${settings.rate.toFixed(1)}×`,
          change: (rate: number) => set((held) => ({ ...held, rate })),
        },
        {
          label: 'Bright range',
          value: settings.range.bright,
          min: 0,
          max: 32,
          step: 1,
          reading: `+${settings.range.bright} EV`,
          change: (bright: number) =>
            set((held) => ({ ...held, range: { ...held.range, bright } })),
        },
        {
          label: 'Dark range',
          value: settings.range.dark,
          min: 0,
          max: 24,
          step: 1,
          reading: `−${settings.range.dark} EV`,
          change: (dark: number) =>
            set((held) => ({ ...held, range: { ...held.range, dark } })),
        },
        {
          label: 'Peak luminance',
          value: settings.peak,
          min: 1,
          max: 2,
          step: 0.05,
          reading: `${settings.peak.toFixed(2)}× white`,
          change: (peak: number) => set((held) => ({ ...held, peak })),
        },
        {
          label: 'White balance',
          value: settings.balance,
          min: 2000,
          max: 12000,
          step: 50,
          reading: settings.balance === 6500 ? 'D65' : `${settings.balance} K`,
          change: (balance: number) => set((held) => ({ ...held, balance })),
        },
      ].map((control) => (
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
          label="Reset canopy"
          onClick={() => set(DEFAULT_SENSOR_SETTINGS)}
        />
      </div>
    </Section>
  )
}
