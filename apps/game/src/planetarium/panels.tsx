'use no memo'
import { useMemo, useState } from 'react'
import {
  Circle,
  Compass,
  Eye,
  EyeOff,
  Gauge,
  Globe,
  Pause,
  Play,
  Search,
  Star,
  Tag,
  Telescope,
} from 'lucide-react'
import { AU, formatDistance, LIGHT_YEAR } from '@inertialref/shared'
import { compassDegrees } from '@inertialref/rendering'
import type { TravelTarget } from '@inertialref/devtools'
import { DEFAULT_FILL } from '@inertialref/devtools'
import { Input } from '@/components/ui/input'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { PlanetariumContext } from './context.ts'
import { usePolled } from '../hud/usePolled.ts'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { Action, Row, Section } from '../hud/widgets.tsx'
import { nextWarp } from '../hud/warp.ts'
import { PhaseCrescent, PhaseGibbous, PhaseHalf } from '../icons/index.tsx'

/*
 * The planetarium's instruments.
 *
 * Every one of them is a thin reading of the harness — `ir.targets()`,
 * `ir.observatory`, the clock — and nothing here holds a fact the engine does
 * not already own. That is the same rule the dev dock follows and it is worth
 * restating because a planetarium is exactly the kind of interface that grows a
 * parallel model of the universe in component state: a cached list of systems
 * that is one jump out of date, a selected object that disagrees with the
 * camera. The panels poll; the harness answers.
 */

/* ------------------------------------------------------------------------- */
/* Catalogue                                                                  */
/* ------------------------------------------------------------------------- */

export function CataloguePanel({ engine, target, focus }: PlanetariumContext) {
  const [query, setQuery] = useState('')
  const targets = usePolled(() => engine.harness.targets({ lightYears: 16 }), 2)

  /*
   * Filtered here rather than by the harness, because `travelTargets` is a
   * *survey* — it costs a star sweep — and re-running it per keystroke would
   * put a 16 light-year query behind every letter typed. The list is a few
   * hundred rows; filtering it in the client is free.
   */
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return targets
    return targets.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) ||
        row.address.toLowerCase().includes(needle),
    )
  }, [targets, query])

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <label className="flex items-center gap-1.5 rounded border border-slate-700/60 bg-slate-900/60 px-2 focus-within:border-sky-500/60">
        <Search aria-hidden className="size-3 shrink-0 text-slate-500" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="name or address"
          aria-label="Search the catalogue"
          className="h-7 border-0 bg-transparent px-0 font-mono text-[11px] shadow-none focus-visible:ring-0"
        />
        <span className="shrink-0 text-[10px] text-slate-600 tabular-nums">
          {rows.length}
        </span>
      </label>

      <ul className="flex flex-col">
        {rows.map((row) => (
          <CatalogueRow
            key={row.address}
            row={row}
            selected={row.address === target}
            onFocus={() => focus(row.address)}
          />
        ))}
        {rows.length === 0 && (
          <li className="px-1 py-2 text-slate-500">
            nothing within 16 ly matches that
          </li>
        )}
      </ul>
    </div>
  )
}

function CatalogueRow({
  row,
  selected,
  onFocus,
}: {
  row: TravelTarget
  selected: boolean
  onFocus: () => void
}) {
  const Glyph = row.kind === 'system' ? Star : row.depth > 1 ? Circle : Globe
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        onClick={(event) => {
          releaseFocus(event)
          onFocus()
        }}
        style={{ paddingLeft: `${row.depth * 0.75 + 0.25}rem` }}
        className={`flex w-full items-center gap-1.5 rounded py-0.5 pr-1 text-left transition-colors ${FOCUS_RING} ${
          selected
            ? 'bg-sky-500/15 text-sky-200'
            : 'text-slate-300 hover:bg-slate-800/60 hover:text-sky-200'
        }`}
      >
        <Glyph
          aria-hidden
          className={`size-3 shrink-0 ${
            // Loaded means the system is generated and its frames installed —
            // the difference between a star you can look at and one that is
            // still a stub in the catalogue.
            row.loaded ? 'text-sky-400/80' : 'text-slate-600'
          }`}
        />
        <span className="min-w-0 flex-1 truncate">{row.name}</span>
        <span className="shrink-0 text-[10px] text-slate-500 tabular-nums">
          {row.distanceText}
        </span>
      </button>
    </li>
  )
}

/* ------------------------------------------------------------------------- */
/* The selected object                                                        */
/* ------------------------------------------------------------------------- */

export function ObjectPanel({ engine, focus }: PlanetariumContext) {
  const status = usePolled(() => engine.harness.observerStatus())

  if (status === null || status.target === null) {
    return (
      <p className="px-1 py-2 text-slate-500">
        Nothing selected. Click something in the sky, or pick a row in the
        catalogue.
      </p>
    )
  }

  const { target } = status
  return (
    <div className="flex flex-col gap-2">
      <header className="flex items-baseline gap-2">
        <h3 className="text-sm text-slate-100">{target.name}</h3>
        <span className="text-[10px] tracking-widest text-sky-400/70 uppercase">
          {target.kind}
        </span>
      </header>
      <p className="text-slate-400">{target.detail}</p>

      <Section id="planetarium.object.camera" title="camera">
        <Row label="range" value={formatDistance(status.state.distance)} />
        <Row label="altitude" value={status.altitudeText} />
        <Row label="radius" value={formatDistance(target.radius)} />
        <Row
          label="fills"
          value={`${Math.round(status.fill * 100)}% of frame`}
        />
        <Row
          label="phase"
          // `compassDegrees`, not `% 360`: azimuth accumulates unbounded as
          // you drag and `%` keeps the sign, so the readout showed `-327° az`
          // for a heading of 33°. Elevation is clamped to ±90° and needs none
          // of this.
          value={`${compassDegrees(status.state.azimuth)}° az · ${Math.round(
            (status.state.elevation * 180) / Math.PI,
          )}° el`}
        />
      </Section>

      <Section id="planetarium.object.address" title="address">
        <Row label="text" value={target.address} wrap />
        <Row label="frame" value={target.frame} wrap />
      </Section>

      <div className="flex flex-wrap gap-1">
        {/* The one verb that changes canonical state, and it is deliberately
            the odd one out: everything else in the planetarium is a view.
            `docs/design/planetarium.md` calls this the doorway back into the
            game, and it is why it says "fly" rather than "go". */}
        <Action
          label="re-frame"
          title="Frame the target (F)"
          onClick={() => engine.harness.observatory.frameTarget(DEFAULT_FILL)}
        />
        <Action
          label="fill frame"
          title="As close as the camera will go"
          onClick={() => engine.harness.observatory.frameTarget(0.98)}
        />
        <Action
          label="copy address"
          title="The string every verb, save and log uses"
          onClick={() => {
            void navigator.clipboard?.writeText(target.address)
          }}
        />
        <Action
          label="re-centre"
          title="Reset the orbit angles"
          tone="primary"
          onClick={() => focus(target.address)}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/* View                                                                       */
/* ------------------------------------------------------------------------- */

export function ViewPanel({
  labels,
  onLabels,
  orbits,
  onOrbits,
  ship,
  onShip,
  fov,
  onFov,
}: PlanetariumContext) {
  return (
    <div className="flex flex-col gap-2">
      <Toggle
        on={labels}
        onChange={onLabels}
        icon={Tag}
        label="names"
        hint="Draw a name against everything in view"
      />
      <Toggle
        on={orbits}
        onChange={onOrbits}
        icon={Compass}
        label="orbit paths"
        hint="Trace each body's path around its primary"
      />
      <Toggle
        on={ship}
        onChange={onShip}
        icon={Telescope}
        label="show the ship"
        hint="The hull the flight modes fly, drawn where it actually is"
      />

      <label className="mt-1 flex flex-col gap-1">
        <span className="flex items-center justify-between text-[10px] tracking-widest text-sky-400/80 uppercase">
          field of view
          <span className="text-slate-400 tabular-nums">{fov}°</span>
        </span>
        <input
          type="range"
          min={20}
          max={110}
          step={1}
          value={fov}
          aria-label="Field of view"
          onChange={(event) => onFov(Number(event.target.value))}
          className={`h-1 w-full cursor-pointer accent-sky-400 ${FOCUS_RING}`}
        />
      </label>
      {/* A lens choice is a framing choice here, not just a crop: the
          observatory solves its distance against this angle, so narrowing the
          lens pulls the camera back rather than magnifying. */}
      <p className="text-[10px] text-slate-500">
        the camera re-solves its distance, so the subject stays the same size
      </p>
    </div>
  )
}

function Toggle({
  on,
  onChange,
  icon: Icon,
  label,
  hint,
}: {
  on: boolean
  onChange: (on: boolean) => void
  icon: typeof Eye
  label: string
  hint: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={hint}
      onClick={(event) => {
        releaseFocus(event)
        onChange(!on)
      }}
      className={`flex items-center gap-2 rounded px-1 py-1 text-left transition-colors ${FOCUS_RING} ${
        on ? 'text-sky-200' : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="flex-1">{label}</span>
      {on ? (
        <Eye className="size-3.5 text-sky-400" />
      ) : (
        <EyeOff className="size-3.5 text-slate-600" />
      )}
    </button>
  )
}

/* ------------------------------------------------------------------------- */
/* Time                                                                       */
/* ------------------------------------------------------------------------- */

export function TimePanel({ engine }: PlanetariumContext) {
  const world = usePolled(() => engine.harness.status().world)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-label={world.paused ? 'Run' : 'Pause'}
        title={world.paused ? 'Run (Space)' : 'Pause (Space)'}
        onClick={(event) => {
          releaseFocus(event)
          engine.world.clock.setPaused(!world.paused)
        }}
        className={`rounded border border-slate-700 bg-slate-800/60 p-1.5 text-sky-200 hover:border-sky-500/60 ${FOCUS_RING}`}
      >
        {world.paused ? (
          <Play className="size-3.5" />
        ) : (
          <Pause className="size-3.5" />
        )}
      </button>

      <div className="flex items-center gap-1">
        <Action
          label="−"
          title="Slower ( [ )"
          onClick={() => warp(engine, -1)}
        />
        <span className="w-16 text-center text-slate-300 tabular-nums">
          {world.timeScale}×
        </span>
        <Action
          label="+"
          title="Faster ( ] )"
          onClick={() => warp(engine, 1)}
        />
      </div>

      <span className="mx-1 h-4 w-px bg-slate-800" />

      <Gauge aria-hidden className="size-3.5 shrink-0 text-slate-600" />
      <span className="text-slate-400 tabular-nums">{world.timeText}</span>
      {/* What the clock is actually delivering. Below the requested warp when
          the simulation cannot keep up, and saying so is the whole point —
          `hud/PerfPanel.tsx` found that warp above 5× had never worked. */}
      {world.achievedTimeScale < world.timeScale * 0.95 && (
        <span
          className="text-amber-300/80"
          title="The simulation is not keeping up with the requested warp"
        >
          {world.achievedTimeScale.toFixed(1)}× actual
        </span>
      )}
    </div>
  )
}

const warp = (engine: GameEngine, direction: number): void => {
  engine.world.clock.setTimeScale(
    nextWarp(engine.world.clock.timeScale, direction),
  )
}

/* ------------------------------------------------------------------------- */
/* Presets                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Compositions and distances, one press each.
 *
 * The mobile answer, and the reason the directive asks for it: a phone has one
 * finger and no keyboard, so a preset is the only way to reach a framing that
 * would otherwise take a drag, a pinch and a phase solve. It is also the
 * fastest path on a desktop, which is why it is not a mobile-only panel.
 */
const PHASES = [
  { label: 'full', deg: 12, icon: Circle },
  { label: 'gibbous', deg: 55, icon: PhaseGibbous },
  { label: 'half', deg: 90, icon: PhaseHalf },
  { label: 'crescent', deg: 147, icon: PhaseCrescent },
] as const

const RANGES = [
  { label: 'close', fill: 0.95 },
  { label: 'portrait', fill: DEFAULT_FILL },
  { label: 'wide', fill: 0.18 },
] as const

export function PresetsPanel({ engine, focus }: PlanetariumContext) {
  const observatory = engine.harness.observatory
  const status = usePolled(() => engine.harness.observerStatus(), 3)
  const disabled = status?.target == null

  return (
    <div className="flex flex-col gap-2">
      <Section id="planetarium.presets.phase" title="lighting">
        <div className="flex flex-wrap gap-1">
          {PHASES.map((phase) => (
            <button
              key={phase.label}
              type="button"
              disabled={disabled || status?.target?.kind === 'star'}
              title={`${phase.label} — ${phase.deg}° from the sun line`}
              onClick={(event) => {
                releaseFocus(event)
                observatory.setPhase(phase.deg)
              }}
              className={`flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-800/60 px-2 text-[10px] tracking-widest text-slate-300 uppercase transition-colors hover:border-sky-500/60 hover:text-sky-200 disabled:opacity-35 ${FOCUS_RING}`}
            >
              <phase.icon aria-hidden className="size-4" />
              {phase.label}
            </button>
          ))}
        </div>
        {status?.target?.kind === 'star' && (
          // A star has no phase: it is the light source. Saying so beats four
          // buttons that appear to do nothing.
          <p className="mt-1 text-[10px] text-slate-500">
            a star is the light — phase needs something it shines on
          </p>
        )}
      </Section>

      <Section id="planetarium.presets.range" title="framing">
        <div className="flex flex-wrap gap-1">
          {RANGES.map((range) => (
            <Action
              key={range.label}
              label={range.label}
              disabled={disabled}
              title={`Fill ${Math.round(range.fill * 100)}% of the frame`}
              onClick={() => observatory.frameTarget(range.fill)}
            />
          ))}
          <Action
            label="1 AU"
            disabled={disabled}
            title="Back off to one astronomical unit"
            onClick={() => observatory.setDistance(AU)}
          />
          <Action
            label="1 ly"
            disabled={disabled}
            title="Back off to one light year — the system as a point"
            onClick={() => observatory.setDistance(LIGHT_YEAR)}
          />
        </div>
      </Section>

      <Section id="planetarium.presets.tour" title="the tour">
        {/* A short list of places that are worth the first thirty seconds.
            Hard-coded rather than generated: "somewhere impressive" is an
            editorial judgement and there is no field in the catalogue for it. */}
        <div className="flex flex-wrap gap-1">
          {TOUR.map((stop) => (
            <Action
              key={stop.address}
              label={stop.label}
              title={stop.why}
              onClick={() => focus(stop.address)}
            />
          ))}
        </div>
      </Section>
    </div>
  )
}

const TOUR = [
  {
    label: 'Sol',
    address: 'SOL',
    why: 'home, and the only star anyone knows by eye',
  },
  {
    label: 'Earth',
    address: 's:SOL/b:2',
    why: 'the disc every render is judged against',
  },
  {
    label: 'Jupiter',
    address: 's:SOL/b:5',
    why: 'oblate, banded, and the largest thing nearby',
  },
  {
    label: 'Saturn',
    address: 's:SOL/b:6',
    why: 'the rings, which are real geometry here',
  },
  {
    label: 'Alpha Cen',
    address: 'HIP71683',
    why: 'the nearest star system — four light years of nothing to cross',
  },
]
