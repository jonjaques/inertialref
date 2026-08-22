import { BookOpen, TerminalSquare, type LucideIcon } from 'lucide-react'
import { BUILD_ID } from '../build.ts'
import { StellarSpan } from '../icons/index.tsx'
import { OverlayPage } from './OverlayPage.tsx'

/*
 * What this is.
 *
 * Short on purpose. The design bible is fifteen thousand words and it is in the
 * repository; this page's job is to say what the thing in front of you is, name
 * the two claims that make it unusual, and point at the documentation for
 * anyone who wants the rest.
 */

const FACTS: readonly (readonly [string, string])[] = [
  ['catalogue', '7,123 real systems and 702 planets within 150 light years'],
  ['beyond that', 'generated from a seed — identical on every client, forever'],
  ['positions', 'sector index plus offset; sub-millimetre out to 249,000 ly'],
  ['simulation', '64 Hz fixed tick, deterministic, replayable'],
  ['orbits', 'analytic rather than integrated — no drift at any time warp'],
  ['offline', 'the base case, not a degraded mode'],
]

export function AboutPage() {
  return (
    <OverlayPage title="about" subtitle="a real sky, in a browser tab">
      <div className="flex flex-col gap-3">
        <p className="text-slate-300">
          InertialRef is a space flight simulator whose universe is a
          deterministic function of a seed and a star catalogue. There is
          nothing to download and nothing to ask a server for: the galaxy is
          derived, so every client computes the same one.
        </p>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-y border-slate-800 py-2">
          {FACTS.map(([label, value]) => (
            <div key={label} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-sky-300/80">{label}</dt>
              <dd className="text-slate-400">{value}</dd>
            </div>
          ))}
        </dl>

        <p className="text-slate-400">
          Astronomical data comes from HYG (Hipparcos, Yale and Gliese) and the
          NASA Exoplanet Archive. Where a measurement exists it is used; where
          it does not, the generator says so — a body is{' '}
          <span className="text-slate-300">observed</span> or{' '}
          <span className="text-slate-300">projected</span>, and the interface
          never blurs the two.
        </p>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Reference
            icon={BookOpen}
            label="the design bible"
            detail="docs/design/"
          />
          <Reference
            icon={StellarSpan}
            label="the catalogue guide"
            detail="docs/guides/catalogue.md"
          />
          <Reference
            icon={TerminalSquare}
            label="the harness"
            detail="ir.help()"
          />
        </div>

        <p className="pt-1 font-mono text-[10px] text-slate-400">
          {/* The build id is the same string the service worker names its cache
              with. When a stale page is the suspect, this is the first thing
              worth reading out. */}
          build {BUILD_ID}
        </p>
      </div>
    </OverlayPage>
  )
}

/**
 * Where to read more — a record, and now shaped like one.
 *
 * It used to be a bordered chip carrying `FOCUS_RING`, which was wrong twice: a
 * `<span>` has no tab stop, so the focus style could never draw, and the chip
 * was the most clickable-looking thing on a page where none of these three is
 * reachable by clicking. Two are repository paths and one is a console verb.
 * So the costume comes off and they read as what they are — the same label and
 * value pairing the facts above them use.
 */
function Reference({
  icon: Icon,
  label,
  detail,
}: {
  icon: LucideIcon
  label: string
  detail: string
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon aria-hidden className="size-3.5 text-sky-400/70" />
      <span className="text-slate-300">{label}</span>
      <span className="text-slate-400">{detail}</span>
    </span>
  )
}
