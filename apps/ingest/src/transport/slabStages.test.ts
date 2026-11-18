import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/*
 * The stages' directory is read from the environment when the module
 * loads, so it is named before the import and the modules are imported
 * inside the test.
 */

const directory = `${mkdtempSync(join(tmpdir(), 'slab-stages-'))}/`

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('the generator’s stages', () => {
  it('are kept where IR_SLAB_DATA says, rows as JSON and a table as its bytes', async () => {
    vi.stubEnv('IR_SLAB_DATA', directory)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const stages = await import('./slabStages.ts')
    expect(stages.STAGES).toBe(directory)
    expect(stages.RENDERING.endsWith('/packages/rendering/src/')).toBe(true)
    stages.saveStage('rows', [{ depth: 5 }, { depth: 7 }])
    expect(stages.loadStage('rows')).toEqual([{ depth: 5 }, { depth: 7 }])
    const table = Float64Array.of(0, -1.5, Math.PI, 1e-300)
    stages.saveTable('table', table)
    expect(Array.from(stages.loadTable('table'))).toEqual(Array.from(table))
    expect(() => stages.loadStage('absent')).toThrow()
  })

  it('give a form’s table back as a march reads it: half floats, rounded once', async () => {
    vi.stubEnv('IR_SLAB_DATA', directory)
    const stages = await import('./slabStages.ts')
    const { stageTable, threeForms } = await import('./slabSourceTable.ts')
    const form = threeForms(0.5)[0]!
    const over = 1 + 2 ** -11 + 2 ** -40
    stages.saveTable(
      `source-small-${form.name}`,
      Float64Array.from({ length: 2 * 2 * 2 * 4 }, (_, at) =>
        at === 0 ? over : at / 7,
      ),
    )
    const grid = {
      nodes: 2,
      suns: 2,
      sunMuMin: 0.05,
      depthScale: 0.02,
      depthMax: 16,
    }
    const table = stageTable(
      {
        name: 'small',
        grid,
        streams: 8,
        transport: 'formula',
        asymmetry: 0.7,
        digest: '',
        delta: 0,
        modes: 1,
        forms: [form.name],
      },
      form,
    )
    expect(table).toMatchObject({ ...grid, slabs: 1 })
    expect(table.terms).toHaveLength(32)
    // Just over halfway between two half floats: up, not to the even one.
    expect(table.terms[0]).toBe(1 + 2 ** -10)
    for (let at = 1; at < 32; at += 1)
      expect(table.terms[at]).toBe(Math.f16round(at / 7))
  })
})
