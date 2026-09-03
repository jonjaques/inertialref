import { describe, expect, it } from 'vitest'
import {
  BAND_STACK,
  bareGround,
  type Body,
  findBody,
  packedStageOn,
  parseAddress,
  SCALAR,
  SCALARS_AT,
  seaDatumElevation,
  SOL,
  stageOn,
  surfaceKernel,
  terrainSketch,
  walkBodies,
} from '@inertialref/universe'
import { openSession } from './session.ts'
import { terrainZoo } from './terrainZoo.ts'

/*
 * The band stack's structure, held between its two evaluations in Node.
 *
 * `terrainKernel.gpu.test.ts` holds the two fields to a tolerance on the
 * physical adapter, and that is the only test that can hold a band's
 * *arithmetic*. What it does not have to be the only test of is the structure
 * around the bands: the kernel gates each stage on a slot the packer zeroes
 * to mean what the body's own gate means, and whether the packer means the
 * same thing is a question about two TypeScript functions. This asks it over
 * every body in the zoo, in milliseconds, so a gate that moves in `evaluate`
 * without moving in `pack` fails here rather than on an adapter.
 */

const session = openSession({ seed: 'inertialref', workers: null })

function bodyAt(address: string): Body {
  const parsed = parseAddress(address)
  if (parsed.kind !== 'body') throw new Error(`not a body: ${address}`)
  const body = findBody(session.world.loadSystem(parsed.system), parsed.body)
  if (body === undefined) throw new Error(`no body at ${address}`)
  return body
}

function solBody(name: string): Body {
  for (const body of walkBodies(session.world.loadSystem(SOL))) {
    if (body.name === name) return body
  }
  throw new Error(`no ${name} in Sol`)
}

const bodies = (): readonly Body[] => [
  ...terrainZoo(session.world).map((entry) => bodyAt(entry.address)),
  solBody('Luna'),
  solBody('Earth'),
  solBody('Mercury'),
]

describe('the band stack', () => {
  it('has each gated stage packed into the slot the kernel reads', () => {
    // Every stage that can be off names the slot the kernel gates on; the
    // always-on landform bands name none and run in both evaluations.
    for (const stage of BAND_STACK) {
      expect(stage.on === null).toBe(stage.packed === null)
    }
  })

  it("encodes every gate as the body's own, on every body, for both sides of the sea", () => {
    const disagreements: string[] = []
    for (const body of bodies()) {
      const surface = body.surface
      if (bareGround(surface)) continue
      const sketch = terrainSketch(surface)
      const sea = seaDatumElevation(surface)
      for (const seabed of [false, true]) {
        const pack = surfaceKernel(surface, seabed)
        const context = { surface, sketch, sea, seabed }
        for (const stage of BAND_STACK) {
          if (stage.on === null) continue
          const body_ = stageOn(stage.id, context)
          const packed = packedStageOn(pack, stage.id)
          if (body_ !== packed)
            disagreements.push(
              `${body.name} ${stage.id} seabed=${seabed}: body ${body_}, packed ${packed}`,
            )
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  it('packs a bare body as bare', () => {
    // The whole stack is skipped on a zero budget, on both sides: the CPU
    // returns before it and the kernel's stack is the `Else` of this slot.
    for (const body of bodies()) {
      const pack = surfaceKernel(body.surface)
      const budget = pack.records[SCALARS_AT * 4 + SCALAR.BUDGET]!
      expect(budget <= 0).toBe(bareGround(body.surface))
    }
  })

  it('names the drawn tail as presentational and the rest as canon', () => {
    // The canonical/drawn split is the line ADR-0021 draws, and the table is
    // where it is written down for the stages.
    const drawn = BAND_STACK.filter((stage) => !stage.canonical).map(
      (stage) => stage.id,
    )
    expect(drawn).toEqual(['tail', 'grit', 'clamp'])
    // A stage the tail depends on being after: the coast is the last canonical
    // one, so a crater on the shore is a bay and the grit is not flattened.
    const ids = BAND_STACK.map((stage) => stage.id)
    expect(ids.indexOf('coast')).toBeGreaterThan(ids.indexOf('craters'))
    expect(ids.indexOf('tail')).toBeGreaterThan(ids.indexOf('coast'))
    expect(ids.indexOf('clamp')).toBe(ids.length - 1)
  })
})
