import { formatDistance } from '@inertialref/shared'
import { compassDegrees } from '@inertialref/rendering'
import { DEFAULT_FILL } from '@inertialref/devtools'
import { Badge } from '@/components/ui/badge'
import { Action } from '../hud/Action.tsx'
import { Row } from '../hud/Row.tsx'
import { Section } from '../hud/Section.tsx'
import { useEngine } from '../state/engineStore.ts'
import type { PlanetariumContext } from './context.ts'

/** What the camera is on, in detail — and the one verb that leaves the mode. */
export function ObjectPanel({ engine, focus }: PlanetariumContext) {
  const status = useEngine((snapshot) => snapshot.observer)

  if (status === null || status.target === null) {
    return (
      <p className="px-1 py-2 text-slate-400">
        Nothing selected. Click something in the sky, or pick a row in the
        catalog.
      </p>
    )
  }

  const { target } = status
  return (
    <div className="flex flex-col gap-2">
      <header className="flex items-baseline gap-2">
        {/*
         * The display face, and the only place inside a panel it is set.
         *
         * The rule this follows is the one the front door and the IR menu
         * follow: the serif names a *place*. A mode is a place, a page is a
         * place, and the body the camera is pointed at is the place you are
         * currently in — which is exactly what this panel is the readout for.
         * Everything under it is instrument and stays instrument.
         */}
        <h3 className="type-title text-slate-100">{target.name}</h3>
        {/* `rounded`, not the registry's pill — the same override `ModeLink`
            and `ShellBar` make, for the same reason: this system has two radii
            and neither of them is a pill. */}
        <Badge
          variant="ghost"
          className="type-label rounded px-0 py-0 font-normal text-sky-400/70"
        >
          {target.kind}
        </Badge>
      </header>
      <p className="type-readout text-slate-400">{target.detail}</p>

      <Section id="planetarium.object.camera" title="Camera">
        <Row label="Range" value={formatDistance(status.state.distance)} />
        <Row label="Altitude" value={status.altitudeText} />
        <Row label="Radius" value={formatDistance(target.radius)} />
        <Row
          label="Fills"
          value={`${Math.round(status.fill * 100)}% of frame`}
        />
        <Row
          label="Phase"
          // `compassDegrees`, not `% 360`: azimuth accumulates unbounded as
          // you drag and `%` keeps the sign, so the readout showed `-327° az`
          // for a heading of 33°. Elevation is clamped to ±90° and needs none
          // of this.
          value={`${compassDegrees(status.state.azimuth)}° az · ${Math.round(
            (status.state.elevation * 180) / Math.PI,
          )}° el`}
        />
      </Section>

      <Section id="planetarium.object.address" title="Address">
        <Row label="Text" value={target.address} wrap />
        <Row label="Frame" value={target.frame} wrap />
      </Section>

      <div className="flex flex-wrap gap-1">
        {/* The one verb that changes canonical state, and it is deliberately
            the odd one out: everything else in the planetarium is a view.
            `docs/design/planetarium.md` calls this the doorway back into the
            game, and it is why it says "fly" rather than "go". */}
        <Action
          label="Re-frame"
          title="Frame the target (F)"
          onClick={() => engine.harness.observatory.frameTarget(DEFAULT_FILL)}
        />
        <Action
          label="Fill Frame"
          title="As close as the camera will go"
          onClick={() => engine.harness.observatory.frameTarget(0.98)}
        />
        <Action
          label="Copy Address"
          title="The string every verb, save and log uses"
          onClick={() => {
            void navigator.clipboard?.writeText(target.address)
          }}
        />
        <Action
          label="Re-center"
          title="Reset the orbit angles"
          tone="primary"
          onClick={() => focus(target.address)}
        />
      </div>
    </div>
  )
}
