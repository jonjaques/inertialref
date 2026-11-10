import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openSession } from '@inertialref/devtools'
import {
  bodyWeather,
  cloudFieldAt,
  columnDepth,
  fieldClock,
  regimeWeather,
} from '@inertialref/rendering'
import { findBody, parseAddress } from '@inertialref/universe'
import { loadStarCatalog } from './catalog.ts'

/*
 * The weather is presentation. It is derived from a body's record and an
 * instant, read by the renderer and the references, and stored and hashed
 * nowhere (rule 17), so evaluating it must leave the canonical world exactly
 * as it was: a world stepped with the field asked between every tick hashes
 * as one stepped without it.
 *
 * And its modules may not reach the simulation at all. `pnpm graph` allows
 * the rendering package to import the simulation (layer 5 over 4), so the
 * only thing that keeps the field from reading a world's clock or a ship's
 * position is that none of these files names it, and a grep is what can
 * see that. The same grep holds the field to no wall clock and no random
 * source, which `packages.md` forbids the whole core but which matter here
 * because the field's twin on the GPU is checked against it texel by texel.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url))

/** Ticks each world steps: three seconds at 60 Hz. */
const TICKS = 180

function earth(session: ReturnType<typeof openSession>) {
  const parsed = parseAddress('g:milky-way/s:SOL/b:2')
  if (parsed.kind !== 'body') throw new Error('Earth is a body')
  return findBody(session.world.loadSystem(parsed.system), parsed.body)!
}

describe('the weather is not canonical', () => {
  // 5.8 s in the root suite on this Mac mini (Apple M6), four workers;
  // CI's hosted runner is 2.1 to 3.9 times slower, up to 23 s. Five times that.
  it('leaves the world’s hash as it was when the field is asked between every tick', () => {
    const plain = openSession({ catalog: loadStarCatalog(), workers: null })
    const asked = openSession({ catalog: loadStarCatalog(), workers: null })
    try {
      const start = asked.world.stateHash()
      expect(start).toBe(plain.world.stateHash())
      const body = earth(asked)
      const weathers = [bodyWeather(body)!, regimeWeather(body, 'fair-cumulus')]
      const sun = { x: 0.3, y: 0.2, z: 0.93 }
      let read = 0
      for (let tick = 0; tick < TICKS; tick += 1) {
        plain.world.step()
        asked.world.step()
        const time = asked.world.clock.renderTime
        for (const weather of weathers) {
          const clock = fieldClock(weather, time)
          const level = weather.levels[0]
          const r = weather.datumRadius + (level.base + level.top) / 2
          const direction = { x: 0.6, y: 0.48, z: 0.64 }
          const at = cloudFieldAt(
            weather,
            clock,
            sun,
            { x: direction.x * r, y: direction.y * r, z: direction.z * r },
            tick * 10,
          )
          read += at.fraction + columnDepth(weather, clock, sun, direction, 0)
        }
      }
      expect(Number.isFinite(read)).toBe(true)
      expect(asked.world.clock.time).toBe(plain.world.clock.time)
      // The ship moved, so the two hashes agree on a world that changed.
      expect(asked.world.stateHash()).not.toBe(start)
      expect(asked.world.stateHash()).toBe(plain.world.stateHash())
    } finally {
      plain.dispose()
      asked.dispose()
    }
  }, 120_000)

  it('reads no simulation, no wall clock and no random source', () => {
    const files = globSync('packages/rendering/src/weather*.ts', {
      cwd: root,
    }).filter((file) => !file.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThanOrEqual(7)
    for (const file of files) {
      const source = readFileSync(path.join(root, file), 'utf8')
      expect(source, file).not.toMatch(/@inertialref\/simulation/)
      expect(source, file).not.toMatch(/\bMath\.random\s*\(/)
      expect(source, file).not.toMatch(/\bDate\.now\s*\(/)
      expect(source, file).not.toMatch(/\bperformance\s*\./)
    }
  })
})
