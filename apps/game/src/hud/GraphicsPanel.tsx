import { AA_LEVELS, type AaLevel } from '../render/output.ts'
import { Section } from './widgets.tsx'

/*
 * Render-feature switches.
 *
 * The panel exists for the shape of the problem: a rendering feature under
 * visual iteration needs an off switch, both to see a before/after without
 * reloading and to isolate an artifact to its source — which is exactly how
 * the lens flare's alpha-compositing bug was pinned to the flare rather than
 * the tone curve. Switches write plain engine fields; the frame loop reads
 * them, and nothing here re-renders per frame.
 */

export interface GraphicsState {
  readonly lensFlare: boolean
  readonly onLensFlare: (on: boolean) => void
  readonly aa: AaLevel
  readonly onAa: (level: AaLevel) => void
}

export function GraphicsPanel({ graphics }: { graphics: GraphicsState }) {
  return (
    <div>
      <Section id="graphics.features" title="features">
        <Toggle
          label="lens flare"
          detail="ghosts, streak and glow when the star is in frame"
          on={graphics.lensFlare}
          onChange={graphics.onLensFlare}
        />
        <Cycle
          label="anti-aliasing"
          detail="2× is hardware msaa; 4× adds a 2×2 supersampled buffer"
          value={graphics.aa}
          values={AA_LEVELS}
          onChange={graphics.onAa}
        />
      </Section>
    </div>
  )
}

/** A labelled row that steps through a fixed set of values on click. */
function Cycle<T extends string>({
  label,
  detail,
  value,
  values,
  onChange,
}: {
  label: string
  detail: string
  value: T
  values: readonly T[]
  onChange: (next: T) => void
}) {
  return (
    <button
      type="button"
      title={detail}
      onClick={(event) => {
        event.currentTarget.blur()
        const next = values[(values.indexOf(value) + 1) % values.length]
        if (next !== undefined) onChange(next)
      }}
      className="flex w-full items-center justify-between gap-2 rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1 text-left hover:border-sky-500/40"
    >
      <span className="min-w-0">
        <span className="text-slate-300">{label}</span>
        <span className="ml-2 truncate text-slate-600">{detail}</span>
      </span>
      <span className="shrink-0 text-[10px] uppercase tracking-widest text-sky-300">
        {value}
      </span>
    </button>
  )
}

/** A labelled on/off row. Local until a second panel needs one. */
function Toggle({
  label,
  detail,
  on,
  onChange,
}: {
  label: string
  detail: string
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      title={detail}
      onClick={(event) => {
        event.currentTarget.blur()
        onChange(!on)
      }}
      className="flex w-full items-center justify-between gap-2 rounded border border-slate-800/80 bg-slate-900/40 px-2 py-1 text-left hover:border-sky-500/40"
    >
      <span className="min-w-0">
        <span className="text-slate-300">{label}</span>
        <span className="ml-2 truncate text-slate-600">{detail}</span>
      </span>
      <span
        className={`shrink-0 text-[10px] uppercase tracking-widest ${
          on ? 'text-sky-300' : 'text-slate-600'
        }`}
      >
        {on ? 'on' : 'off'}
      </span>
    </button>
  )
}
