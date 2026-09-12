import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scanner = fileURLToPath(new URL('./scan.mjs', import.meta.url))
function check(source, args = []) {
  const root = mkdtempSync(join(tmpdir(), 'ir-spelling-'))
  try {
    mkdirSync(join(root, 'packages/sample/src'), { recursive: true })
    writeFileSync(join(root, 'packages/sample/src/sample.ts'), source)
    mkdirSync(join(root, 'apps/server/src'), { recursive: true })
    writeFileSync(
      join(root, 'apps/server/src/worker-configuration.d.ts'),
      'declare const cancelled: boolean',
    )
    return spawnSync(process.execPath, [scanner, '--root', root, ...args], {
      encoding: 'utf8',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
describe('the spelling gate', () => {
  it('reports findings without failing the inventory command', () => {
    const result = check('export const colour = 1', ['--json'])
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).map((row) => row.name)).toEqual(['colour'])
  })
  it('fails for public and private declarations', () => {
    const result = check(
      'export const colour = 1; class Palette { #colour = 1 }',
      ['--check', '--json'],
    )
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).map((row) => row.name)).toEqual([
      'colour',
      '#colour',
    ])
  })
  it('fails for quoted property declarations', () => {
    const result = check("export interface Paint { 'colour': number }", [
      '--check',
      '--json',
    ])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout).map((row) => row.name)).toEqual(['colour'])
  })
  it('permits prose examples and generated vendor declarations', () => {
    const result = check(
      "export const color = 1; export const example = 'colour'",
      ['--check'],
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0 identifier declarations')
  })
})
