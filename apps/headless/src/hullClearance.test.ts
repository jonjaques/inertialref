import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Quaternion as Q, UV } from '@inertialref/spatial'
import { openSession, TNG_INTRO } from '@inertialref/devtools'
import { type HullField, readHullField } from './hullField.ts'

/*
 * A cutscene may not fly its camera through the hero prop.
 *
 * This is the one thing about a staged shot that the reference diff is
 * structurally unable to see. `compare_render.py` scores the largest lit mass
 * in the frame; a camera *inside* the saucer still produces a large lit mass —
 * the inside of the plating — and it scores about as well as the shot that was
 * intended. `tng-intro`'s skim flew through the disc for forty-eight frames,
 * f2234–2281, by up to 3.5 m, and grazed within a meter either side of that,
 * while every number in the band looked reasonable. It was found by eye.
 *
 * So the check is geometric, headless, and reads the shipped asset rather than
 * a number somebody wrote down: `hullField.ts` decodes the glTF's vertex
 * positions in Node and reduces them to a per-column height field in the hull's
 * own axes, and this walks every frame the hull is on stage and asks where the
 * camera is relative to it.
 *
 * **Deliberately a test and not a runtime clamp.** A director that quietly
 * pushed the camera out whenever a beat came too close would make an authoring
 * mistake invisible and would put a conditional in the middle of the one thing
 * a scripted scene has to be — reproducible. The beats are the record; this
 * says when they are wrong.
 */

const root = fileURLToPath(new URL('../../..', import.meta.url))
const manifest = JSON.parse(
  readFileSync(`${root}/data/models/manifest.json`, 'utf8'),
) as {
  models: {
    id: string
    file: string
    lengthMetres: number
    nose: '+z' | '-z'
  }[]
}

/**
 * How much daylight the camera has to keep, meters.
 *
 * Two things it covers, and neither is taste. The field samples **vertices** on
 * an 8 m grid, so a large flat triangle bulges above the highest vertex in its
 * column by up to about half a cell — 4 m of surface the field cannot see. And
 * the hull is a prop with a near clip plane in front of it: a camera that
 * misses the plating by a meter still slices it open. Fifteen meters is a
 * little under two cells, which is the resolution this instrument has.
 *
 * The staged skim clears by 22.7 m at its tightest (f2277), so this is not a
 * bound the beats are tuned against — it is the bound below which the answer
 * stops meaning anything.
 */
const CLEARANCE_MARGIN_M = 15

describe('cutscene camera against the hero hull', () => {
  const spec = manifest.models.find((m) => m.id === 'enterprise-d')
  if (spec === undefined)
    throw new Error('no enterprise-d in the model manifest')

  /*
   * Decoded on first use, not in the `describe` body.
   *
   * This is the only test in the repository that reads git-lfs content, and a
   * throw out here is a *collection* error: vitest reports the suite as unable
   * to load and every test in it disappears, rather than one test failing with
   * a reason. That is how a checkout without `lfs: true` presented itself —
   * as "1 failed suite", with the actual sentence about the glTF three screens
   * up. Memoized because decoding 13.9 MB per test is the reason it was
   * hoisted in the first place.
   */
  let decoded: HullField | null = null
  const hull = (): HullField =>
    (decoded ??= readHullField(
      `${root}/data/models/${spec.file}`,
      spec.lengthMetres,
      spec.nose,
    ))

  it('reads the shipped hull, in the axes the renderer builds it in', () => {
    /*
     * The instrument's own check, and it is the one that matters: this file
     * restates `shipModels.ts`'s recenter/rotate/rescale rather than importing
     * it — `apps/game` cannot be loaded in Node, it is Three.js all the way
     * down — so if the two ever disagree, every assertion below is measuring a
     * differently-shaped ship and passing. The manifest's length is the shared
     * input, and a Z extent that is not it means the transform has drifted.
     */
    expect(hull().extent.z).toBeCloseTo(spec.lengthMetres, 1)
    // A Galaxy-class saucer is 463.7 m across and the hull 142 m deep; both
    // fall out of the same scale, so they are a second reading of it.
    expect(hull().extent.x).toBeGreaterThan(400)
    expect(hull().extent.x).toBeLessThan(500)
    expect(hull().extent.y).toBeGreaterThan(100)
    expect(hull().extent.y).toBeLessThan(200)
    // Enough columns that the field is a shape rather than a handful of points.
    expect(hull().columns).toBeGreaterThan(1000)
  })

  it('clears the hull at every frame the hull is on stage', () => {
    const session = openSession()
    session.harness.play('tng-intro')
    const at = (frame: number) =>
      session.harness.cutsceneSample(100 + frame / TNG_INTRO.fps)
    // The first sample anchors frame 0 to its epoch.
    at(0)

    const field = hull()
    let staged = 0
    let worst = { frame: -1, depth: -Infinity }
    for (let frame = 0; frame < TNG_INTRO.durationFrames; frame += 1) {
      const sample = at(frame)
      if (sample === null || !sample.ship.visible) continue
      staged += 1
      // The camera, in the hull's own axes.
      const inHull = Q.rotate(
        Q.conjugate(sample.ship.orientation),
        UV.difference(sample.camera.position, sample.ship.position),
      )
      const depth = field.depthInside(inHull)
      if (depth > worst.depth) worst = { frame, depth }
    }

    /*
     * The sweep found frames to look at.
     *
     * `depthInside` answers `-Infinity` for a column with no geometry and
     * `worst` starts there, so `expect(-Infinity).toBeLessThan(-15)` passes a
     * sweep that examined nothing at all — a `SHIP_WINDOWS` edit that hid the
     * hull, a transform drift that put every camera outside the field, or an
     * epoch that never anchored. An instrument whose failure mode is silence
     * has to say how much it looked at.
     */
    expect(staged, 'no frame put the hull on stage').toBeGreaterThan(1000)
    expect(
      worst.depth,
      `f${worst.frame} puts the camera ${(-worst.depth).toFixed(1)} m from the ` +
        `hull's surface; a scene may not fly its camera through its own prop`,
    ).toBeLessThan(-CLEARANCE_MARGIN_M)
  })

  it('would notice the skim as it was authored before this test existed', () => {
    /*
     * The regression this was written for, held as a fixture rather than as a
     * memory. These are the camera's measured positions in hull axes on the
     * previous skim beats — f2188 is the frame that reads as the saucer's
     * interior, and f2260 is the deepest of the forty-eight that were inside.
     * If the field ever stops calling these what it called them, it has stopped
     * describing this ship.
     */
    expect(
      hull().depthInside({ x: -29.3, y: 74.7, z: -102.4 }),
    ).toBeGreaterThan(-CLEARANCE_MARGIN_M)
    expect(
      hull().depthInside({ x: -19.9, y: 66.6, z: -136.3 }),
    ).toBeGreaterThan(0)
    // And a camera well clear of the plating is clear by this instrument too.
    expect(hull().depthInside({ x: 0, y: 400, z: 0 })).toBeLessThan(
      -CLEARANCE_MARGIN_M,
    )
    /*
     * So is one kilometers away, which the packed column key used to get
     * wrong: `(i + 4096) * 8192 + (j + 4096)` aliases the moment either index
     * leaves ±4096, and this point — 65.5 km astern — read as 32.8 m *inside*
     * the hull. The sweep already asks about camera positions up to 968 km out
     * in hull axes, so the domain is crossed on real frames and only luck kept
     * the aliased keys off occupied columns.
     */
    for (const z of [65536, 131072, -65536, 968472])
      expect(hull().depthInside({ x: 0, y: 0, z }), `z=${z}`).toBe(-Infinity)
  })
})
