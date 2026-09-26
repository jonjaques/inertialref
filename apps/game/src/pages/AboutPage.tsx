import { BookOpen, TerminalSquare } from 'lucide-react'
import { BUILD_ID } from '../build.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { Github, StellarSpan } from '../icons/index.tsx'
import { SITE } from '../site.ts'
import { OverlayPage } from './OverlayPage.tsx'
import { Reference } from './Reference.tsx'

/*
 * What this is.
 *
 * Short on purpose. The design bible is in the repository; this page's job is
 * to say what the thing in front of you is, state the milestone honestly, and
 * point at the source and the docs for anyone who wants the rest.
 */

const FACTS: readonly (readonly [string, string])[] = [
  ['Status', 'Pre-alpha — flight and surface exploration'],
  ['Catalog', '7,123 real systems and 702 planets within 150 light years'],
  ['Beyond That', 'Generated from a seed — identical on every client, forever'],
  ['Proven', '12/12 milestone capabilities, in the browser and in Node'],
  [
    'Modes',
    'Flight, surface exploration, planetarium, cinema, and authoring panels',
  ],
  ['Offline', 'The base case — the galaxy is derived, not downloaded'],
]

export function AboutPage() {
  return (
    <OverlayPage title="About" subtitle={SITE.tagline}>
      <div className="flex flex-col gap-3">
        <p className="text-slate-300">
          {SITE.name} is an open-source spaceflight simulator whose universe is
          a deterministic function of a seed and a star catalog. Fly between
          worlds, land, and explore solid terrain on foot with first-person or
          third-person controls.
        </p>

        <p className="text-slate-400">
          The real catalog extends 150 light years, with procedural generation
          beyond it. Browse the live sky in the planetarium, watch scripted
          scenes in the cinema, or use the authoring workspace to compose your
          own. Survival, missions, and progression are still planned.
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
          never blurs the two. Licensed {SITE.license}.
        </p>

        <p className="text-slate-400">
          The spacesuit adapts DigitalSpace Corporation’s Astronaut model from{' '}
          <a
            href="https://science.nasa.gov/3d-resources/astronaut/"
            target="_blank"
            rel="noreferrer"
            className={`rounded text-sky-300 hover:text-sky-200 ${FOCUS_RING}`}
          >
            NASA 3D Resources
          </a>
          , with a modified silhouette, neutral materials, and original rigging
          and animation. NASA does not endorse this project.
        </p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
          <a
            href={SITE.repository}
            target="_blank"
            rel="noreferrer"
            className={`flex min-h-6 items-center gap-1.5 rounded text-sky-300 transition-colors hover:text-sky-200 ${FOCUS_RING}`}
          >
            <Github aria-hidden className="size-3.5" />
            Source on GitHub
          </a>
          <Reference
            icon={BookOpen}
            label="The Design Bible"
            detail="docs/design/"
          />
          <Reference
            icon={StellarSpan}
            label="The Catalog Guide"
            detail="docs/guides/catalog.md"
          />
          <Reference
            icon={TerminalSquare}
            label="The Harness"
            detail="ir.help()"
          />
        </div>

        <p className="type-micro pt-1 text-slate-400">
          {/* The build id is the same string the service worker names its cache
              with. When a stale page is the suspect, this is the first thing
              worth reading out. */}
          Build {BUILD_ID}
        </p>
      </div>
    </OverlayPage>
  )
}
