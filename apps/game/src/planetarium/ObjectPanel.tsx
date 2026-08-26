import { CircleDashed, CornerLeftUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Section } from '../hud/Section.tsx'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { FactRow } from './FactRow.tsx'
import { SatelliteRow } from './SatelliteRow.tsx'
import { iconForKind } from './kinds.ts'
import { useDossier } from './useDossier.ts'
import type { PlanetariumContext } from './context.ts'

/*
 * What this is — as astronomy, and nothing else.
 *
 * The panel this replaced answered a different question. It led with the range
 * to the camera, the fraction of the frame the disk filled, the two orbit
 * angles and the address string: four readings about the *instrument*, on a
 * page whose subject is Mars, and the only thing it said about Mars was a
 * radius. Those four are readings about where you are standing, they are
 * genuinely useful while authoring, and they are in the author's Camera
 * instrument now — `hud/CameraPanel.tsx`, beside the lens they belong to.
 *
 * What is here instead is `dossier.ts`: mass in kilograms and in Earths, the
 * three half-extents of a body gravity never rounded off, the orbit in the
 * unit that scale is actually read in, the synodic day, the atmosphere as a
 * pressure, and how wide the star is in this body's sky. The derivations are
 * there rather than here because they deserve a test in Node; this file is the
 * page.
 *
 * **Empty fields are drawn.** Half a dozen rows on any body say "no data" with
 * the reason behind them, and that is the design rather than a shortfall: a row
 * that is simply absent cannot distinguish "this body has no atmosphere" from
 * "nobody has measured its atmosphere". It also means the panel already has the
 * shape of the record that is coming — every empty field is one a survey will
 * fill. `docs/design/planetarium.md` § "The record that is not filled in yet".
 */
export function ObjectPanel({ engine, target, focus }: PlanetariumContext) {
  const page = useDossier(engine, target)

  if (page === null) {
    return (
      <p className="type-ui px-1 py-2 text-pretty text-slate-400">
        Nothing selected. Click something in the sky, or pick a row in the
        catalog.
      </p>
    )
  }

  const Glyph = iconForKind(page.kind === 'star' ? null : page.kind)

  return (
    <div className="flex flex-col gap-2">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <Glyph
            aria-hidden
            className="mt-1 size-5 shrink-0 text-sky-400/80"
            strokeWidth={1.75}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            {/*
             * The display face, and one of the few places inside a panel it is
             * set. The rule is the one the front door and the IR menu follow:
             * the display face names a *place*. A mode is a place, a page is a
             * place, and the body the camera is pointed at is the place you are
             * currently in — which is exactly what this panel is the readout
             * for. Everything under it is instrument and stays instrument.
             */}
            <h3 className="type-title text-balance text-slate-100">
              {page.name}
            </h3>
            <p className="type-label text-sky-400/80">{page.classification}</p>
          </div>
        </div>

        <p className="type-body text-pretty text-slate-300">{page.summary}</p>

        <div className="flex flex-wrap items-center gap-1.5">
          {/*
           * The way back up the tree, and it is a *link* rather than a row: the
           * primary is where a reader goes after reading a moon, and making it
           * a heading somewhere further down would put the commonest navigation
           * in this panel below six sections.
           */}
          {page.primary !== null && (
            <button
              type="button"
              title={`Look at ${page.primary.name}`}
              onClick={(event) => {
                releaseFocus(event)
                if (page.primary !== null) focus(page.primary.address)
              }}
              className={`type-ui flex min-h-6 items-center gap-1 rounded border border-slate-700 bg-slate-800/60 px-1.5 text-slate-300 transition-colors hover:border-sky-500/60 hover:text-sky-200 active:scale-[0.96] ${FOCUS_RING}`}
            >
              <CornerLeftUp aria-hidden className="size-3" />
              {page.primary.name}
            </button>
          )}
          {/* `rounded`, not the registry's pill — the same override `ModeLink`
              and `ShellBar` make, for the same reason: this system has two radii
              and neither of them is a pill. */}
          {page.provenance === 'projected' && (
            <Badge
              variant="ghost"
              title="Projected from stellar parameters — not confirmed"
              className="type-label rounded border border-slate-700 px-1.5 py-0 font-normal text-slate-400"
            >
              Projected
            </Badge>
          )}
          {page.pendingCount > 0 && (
            <span
              className="type-micro flex items-center gap-1 text-slate-500"
              title="Fields no survey has filled in. Each one says what is missing."
            >
              <CircleDashed aria-hidden className="size-3" />
              {page.pendingCount} unmeasured
            </span>
          )}
        </div>
      </header>

      {page.groups.map((group) => (
        <Section
          key={group.id}
          id={`planetarium.object.${group.id}`}
          title={group.title}
        >
          {group.caption !== undefined && (
            <p className="type-ui mb-1 text-pretty text-slate-400">
              {group.caption}
            </p>
          )}
          <div className="flex flex-col">
            {group.facts.map((fact) => (
              <FactRow key={fact.label} fact={fact} />
            ))}
          </div>
        </Section>
      ))}

      {page.satellites.length > 0 && (
        <Section
          id="planetarium.object.satellites"
          title="Satellites"
          trailing={`${page.satellites.length}`}
        >
          <ul className="flex flex-col">
            {page.satellites.map((moon) => (
              <SatelliteRow
                key={moon.address}
                moon={moon}
                selected={moon.address === target}
                onFocus={() => focus(moon.address)}
              />
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}
