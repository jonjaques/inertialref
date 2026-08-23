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
  ['Status', 'Pre-alpha — architectural proof first; gameplay is not built'],
  ['Catalog', '7,123 real systems and 702 planets within 150 light years'],
  ['Beyond That', 'Generated from a seed — identical on every client, forever'],
  ['Proven', '12/12 milestone capabilities, in the browser and in Node'],
  [
    'Modes',
    'Planetarium, cinema, and dockable authoring panels over a live scene',
  ],
  ['Offline', 'The base case — the galaxy is derived, not downloaded'],
]

export function AboutPage() {
  return (
    <OverlayPage title="About" subtitle={SITE.tagline}>
      <div className="flex flex-col gap-3">
        <p className="text-slate-300">
          {SITE.name} is an open-source spaceflight simulator whose universe is
          a deterministic function of a seed and a star catalog. This build is
          the first milestone: a vertical architectural proof. The graphics are
          primitives; the point is precision, determinism and identity — fly
          from the galactic center to a mountainside, resolve an inch, and get
          the same answer twice.
        </p>

        <p className="text-slate-400">
          There is no gameplay yet. What is here is the platform: the real
          catalog within 150 light years, procedural generation beyond that, a
          planetarium over the live sky, a cinema player for scripted scenes,
          and an authoring workspace that drives the same harness the tests do.
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
          never blurs the two. Licensed {SITE.licence}.
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
            detail="docs/guides/catalogue.md"
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
