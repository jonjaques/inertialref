/*
 * The editorial table: which document belongs where, in what order, under
 * what name, and what the masthead is looking at while you read it.
 *
 * Separate from `routes.mjs` because the two answer different questions and
 * only one of them is mechanical. A route is derived from a path and cannot be
 * argued with; a *wing* is a judgement about who is reading and what they came
 * for — `getting-started.md` lives in `docs/guides/` and belongs at the top of
 * the first wing, because somebody who has never run this needs it before they
 * need anything about how the repository is organised.
 *
 * A page listed here is a page in the site. A markdown file under `docs/` that
 * is not listed is a file the build reports and does not publish, which is the
 * only way a new document can be added without silently ending up nowhere —
 * `build.mjs` fails on an unlisted file rather than guessing a wing for it.
 *
 * ## The masthead is looking at something real
 *
 * Each wing carries a framing: an address in the live simulation, the phase
 * angle to solve the camera against, and how far the swing is rolled out of the
 * star's plane. The scene above a documentation page is the same engine the
 * documentation is about, framed on a real body, and the strip says which body.
 * That is the one thing this project can put at the top of a page that a
 * screenshot cannot fake, and it costs a table.
 *
 * **The numbers are for a band, not for a frame, and that is why they look
 * wrong.** The observatory centres its subject in the whole canvas, and the
 * masthead is the top three hundred pixels of it — so a framing that fills half
 * the frame puts the entire body behind the reading plate, and what is left in
 * the band is the dark cap of a disk nobody can see. `fill` above 1 is the
 * answer: the body overfills the canvas, the band cuts a slice out of it near
 * the top, and what lands in that slice is a limb, an atmosphere and a
 * terminator rather than the top of a circle.
 *
 * The tilts are **negative**, which is the other half. Tilt rolls the camera
 * out of the star's plane, so a positive one puts the camera above it and the
 * lit face below — behind the plate. Negative, the star is above the camera and
 * the light falls on the part of the body the band actually shows. Measured at
 * 1600x900: at `+14` the arc across the masthead is Earth's night side, at
 * `-30` it is the terminator with the sun in frame beside it.
 *
 * The bodies are chosen, not cycled. `b:2` is Earth — the front door's own
 * subject, so arriving at the documentation from the menu is a continuation
 * rather than a cut. `b:5` is Saturn, whose rings are the clearest picture of
 * structure this system can draw. `b:3` is Mars, which is somewhere you would
 * go. `b:4` is Jupiter. `s:SOL` is the star itself, over the reference.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { DOCS } from './routes.mjs'

/** @typedef {{ address: string, phase: number, tilt: number, fill: number }} Framing */

export const WINGS = [
  {
    id: 'start',
    label: 'Start Here',
    blurb: 'What this is, what it is for, and how to run it.',
    framing: { address: 's:SOL/b:2', phase: -135, tilt: -30, fill: 2.2 },
    groups: [
      {
        label: null,
        pages: [
          ['docs/README.md', 'Overview', 'Documentation'],
          'docs/vision.md',
          'docs/architecture.md',
          ['docs/guides/getting-started.md', 'Getting Started'],
          'docs/roadmap.md',
          'docs/spikes.md',
          'docs/glossary.md',
        ],
      },
    ],
  },
  {
    id: 'concepts',
    label: 'Concepts',
    blurb:
      'The ten mechanisms that carry the architecture, and the seventeen decisions underneath them.',
    framing: { address: 's:SOL/b:5', phase: -122, tilt: -26, fill: 1.5 },
    groups: [
      {
        label: 'Mechanisms',
        pages: [
          'docs/concepts/coordinates.md',
          'docs/concepts/frames.md',
          'docs/concepts/determinism.md',
          'docs/concepts/identity.md',
          'docs/concepts/time.md',
          'docs/concepts/rendering.md',
          'docs/concepts/streaming.md',
          'docs/concepts/workers.md',
          'docs/concepts/persistence.md',
          'docs/concepts/observability.md',
        ],
      },
      {
        label: 'Decision Records',
        pages: [
          ['docs/adr/README.md', 'All Records'],
          ['docs/adr/0001-universe-coordinates.md', 'Universe Coordinates'],
          ['docs/adr/0002-reference-frames.md', 'Reference Frames'],
          ['docs/adr/0003-render-coordinates.md', 'Render Coordinates'],
          ['docs/adr/0004-entity-addressing.md', 'Entity Addressing'],
          ['docs/adr/0005-procedural-seeds.md', 'Procedural Seeds'],
          ['docs/adr/0006-simulation-clock.md', 'The Simulation Clock'],
          ['docs/adr/0007-persistence.md', 'Persistence'],
          ['docs/adr/0008-multiplayer-partitions.md', 'Multiplayer Partitions'],
          ['docs/adr/0009-issue-ordinal-addressing.md', 'Issue Ordinals'],
          ['docs/adr/0010-cinematic-director.md', 'The Cinematic Director'],
          ['docs/adr/0011-application-shell-and-modes.md', 'Shell and Modes'],
          ['docs/adr/0012-dockable-panels.md', 'Dockable Panels'],
          ['docs/adr/0013-measured-figures.md', 'Measured Figures'],
          [
            'docs/adr/0014-the-record-with-holes-in-it.md',
            'Holes in the Record',
          ],
          ['docs/adr/0015-terrain-level-of-detail.md', 'Terrain Detail'],
          ['docs/adr/0016-documentation-as-a-mode.md', 'Documentation'],
          ['docs/adr/0017-the-lens.md', 'The Lens'],
          ['docs/adr/0018-the-instrument.md', 'The Instrument'],
          ['docs/adr/0019-the-geology.md', 'The Geology'],
          ['docs/adr/0020-the-face.md', 'The Face'],
          ['docs/adr/0021-the-ground.md', 'The Ground'],
          ['docs/adr/0022-the-timeline.md', 'The Timeline'],
          ['docs/adr/0023-the-gpu-producer.md', 'The GPU Producer'],
          ['docs/adr/0024-the-type-system.md', 'The Type System'],
        ],
      },
    ],
  },
  {
    id: 'game',
    label: 'The Game',
    blurb:
      'The design bible — what the player does, and why each mechanic is the shape it is.',
    framing: { address: 's:SOL/b:3', phase: -140, tilt: -30, fill: 2.0 },
    groups: [
      {
        // The bible's own chapter order, from `docs/design/README.md`. It is an
        // argued sequence — charter before loops before progression — and
        // re-alphabetising it here would throw away the argument.
        label: 'The Bible',
        pages: [
          ['docs/design/README.md', 'Contents'],
          'docs/design/charter.md',
          'docs/design/loops.md',
          'docs/design/progression.md',
        ],
      },
      {
        label: 'Playing',
        pages: [
          'docs/design/flight.md',
          'docs/design/ships.md',
          'docs/design/galaxy.md',
          'docs/design/exploration.md',
          'docs/design/onfoot.md',
          'docs/design/combat.md',
        ],
      },
      {
        label: 'The World',
        pages: [
          'docs/design/content.md',
          'docs/design/world.md',
          ['docs/design/ux.md', 'Interface'],
          ['docs/design/art.md', 'Art Direction'],
          'docs/design/audio.md',
          'docs/design/modes.md',
          'docs/design/planetarium.md',
          'docs/design/cinema.md',
        ],
      },
      {
        label: 'Making It',
        pages: [
          ['docs/design/technical.md', 'Technical Requirements'],
          'docs/design/sustainability.md',
          ['docs/design/competitive.md', 'Competitive Analysis'],
          'docs/design/production.md',
          ['docs/design/risk.md', 'Risk Register'],
          'docs/design/appendix.md',
        ],
      },
    ],
  },
  {
    id: 'working',
    label: 'Working Here',
    blurb:
      'Commands, conventions, and the invariants a change has to leave standing.',
    framing: { address: 's:SOL/b:4', phase: -128, tilt: -34, fill: 2.0 },
    groups: [
      {
        label: 'Guides',
        pages: [
          'docs/guides/development.md',
          'docs/guides/client.md',
          'docs/guides/harness.md',
          'docs/guides/testing.md',
          'docs/guides/extending.md',
          'docs/guides/cinematics.md',
          ['docs/guides/catalogue.md', 'The Star Catalog'],
          'docs/hosting.md',
        ],
      },
      {
        /* A plan describes what is not built yet, so it is not a guide — a
           reader who follows a guide expects the system to already behave that
           way. Filed beside them because the audience is the same one. */
        label: 'Plans',
        pages: [
          ['docs/plans/headless-webgpu.md', 'Headless WebGPU'],
          ['docs/plans/test-speed.md', 'Test Speed'],
          ['docs/plans/the-timeline.md', 'The Timeline'],
          ['docs/plans/perf.md', 'Performance'],
          ['docs/plans/perf-2.md', 'Performance, Second Pass'],
          ['docs/plans/the-shell.md', 'The Shell'],
          ['docs/plans/complexity.md', 'Complexity and Coverage'],
        ],
      },
      {
        label: 'For Agents',
        pages: [
          ['AGENTS.md', 'The Working Card'],
          ['docs/agents/README.md', 'Agent Handbook'],
          ['docs/agents/working.md', 'Working in the Repository'],
          ['docs/agents/invariants.md', 'Invariant Map'],
          ['docs/agents/driving.md', 'Driving the Simulation'],
          ['docs/STYLE.md', 'House Style'],
        ],
      },
    ],
  },
]

/**
 * The reference is a wing with no markdown behind it.
 *
 * Its pages come out of TypeDoc rather than out of `docs/`, and they arrive as
 * a tree that changes whenever an export does — so listing them here would be a
 * table nobody could keep true. `api.mjs` builds this wing's groups; everything
 * else about it, including the framing, is a decision like any other wing's.
 */
export const REFERENCE = {
  id: 'api',
  label: 'Reference',
  blurb:
    'Every export of the twelve engine packages, generated from the source and its comments.',
  /*
   * Neptune, and not the star.
   *
   * `s:SOL` was the obvious choice and the wrong one twice over. A star has no
   * limb to cut a band out of — at any framing that keeps it off the plate it
   * is a point of light behind the plate, and the masthead is black — and at a
   * framing large enough to reach the band it is a wall of blown white behind
   * the title. Neptune is the outermost thing in the catalogue with a real
   * atmosphere, and it is the one body in Sol whose colour is this system's
   * own accent.
   */
  framing: { address: 's:SOL/b:7', phase: -104, tilt: -34, fill: 2.1 },
  /*
   * The one wing with a landing page of its own.
   *
   * The other four are a rail and nothing else — `Concepts` is not a document,
   * it is twenty-six of them — so their name points at their first page, which
   * `build.mjs` works out. This one has an index worth arriving at: twelve
   * packages, their descriptions, and how many exports each carries.
   */
  home: `${DOCS}/api`,
  groups: [],
}

/** Every wing, reference last — the order the navigation draws them in. */
export const allWings = (referenceGroups) => [
  ...WINGS,
  { ...REFERENCE, groups: referenceGroups },
]

/**
 * Every markdown file under `docs/`, as repository paths.
 *
 * Here rather than beside either caller, because there are two and they have to
 * agree about what a document is: `build.mjs` refuses to publish one this finds
 * and the table does not claim, and `routes.test.mjs` asserts the same thing
 * without running a build. Two walks is one of them quietly growing a rule the
 * other does not have.
 */
export async function documentsUnderDocs(root) {
  const found = []
  const walk = async (relative) => {
    for (const item of await readdir(join(root, relative), {
      withFileTypes: true,
    })) {
      const path = `${relative}/${item.name}`
      if (item.isDirectory()) await walk(path)
      else if (item.name.endsWith('.md')) found.push(path)
    }
  }
  await walk('docs')
  return found
}

/** The repository paths this table publishes, in reading order. */
export function listedPages() {
  const listed = []
  for (const wing of WINGS)
    for (const group of wing.groups)
      for (const entry of group.pages) {
        const [path, label, title] = Array.isArray(entry)
          ? entry
          : [entry, null, null]
        listed.push({ path, label, title, wing: wing.id, group: group.label })
      }
  return listed
}
