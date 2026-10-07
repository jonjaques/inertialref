import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openSession, type Session } from '@inertialref/devtools'
import { presentationClock, timeCommands } from './time.ts'

let session: Session | null = null
const open = (): Session => (session = openSession({ workers: null }))
afterEach(() => {
  session?.dispose()
  session = null
})

it('routes shared transport controls to photographic time while a preset holds it', () => {
  const session = open()
  const observer = session.harness.observatory
  const paused = session.world.clock.paused
  const scale = session.world.clock.timeScale
  observer.setTime(120)
  const controls = presentationClock(session)
  controls.setPaused(false)
  controls.setTimeScale(100)
  expect(observer.timePaused).toBe(false)
  expect(observer.timeScale).toBe(100)
  expect(session.world.clock.paused).toBe(paused)
  expect(session.world.clock.timeScale).toBe(scale)
  observer.clear()
  expect(presentationClock(session)).toBe(session.world.clock)
})

describe('the time commands', () => {
  it('say what they did, whichever surface pressed them', () => {
    const session = open()
    const said: string[] = []
    const time = timeCommands(session, (message) => said.push(message))
    time.togglePause()
    time.togglePause()
    time.warp(1)
    time.realTime()
    expect(said).toEqual(['paused', 'running', 'time warp 5×', 'time warp 1×'])
  })

  it('bring a warped, paused world to walking pace, and say nothing when it is already there', () => {
    const session = open()
    const said: string[] = []
    const time = timeCommands(session, (message) => said.push(message))
    time.walkingPace()
    expect(said).toEqual([])
    session.world.clock.setTimeScale(1_000)
    session.world.clock.setPaused(true)
    time.walkingPace()
    expect(session.world.clock.timeScale).toBe(1)
    expect(session.world.clock.paused).toBe(false)
    expect(said).toEqual(['real time, on foot'])
  })
})

/*
 * One writer of the world clock in the app, and one sanctioned exception.
 *
 * A grep, because the writes are method calls on a value — `presentationClock`
 * answers the world clock or the observatory's — and no import edge says which.
 * The harness's `pause`, `resume` and `timeWarp` write the world clock too, so
 * they count. Comments, strings and templates are blanked first, in one pass:
 * this file names the calls it forbids, and a `/*` inside a glob pattern or a
 * `//` inside a URL is not a comment, which a comment-only pass treats as one
 * and so hides the code after it. A write inside a template's `${}` is blanked
 * with the template; nothing writes the clock from one.
 *
 * `tour/executor.ts` calls only the guide's `eye`, the observatory's own
 * clock, which is presentation. `engine/GameEngine.ts` hands the cinema's
 * transport `harness.pause` and `harness.resume`: a playing scene owns the
 * clock, and the cutscene restores it on exit.
 */
describe('the world clock', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  // No `g`: `test` on a global pattern resumes at `lastIndex`, file to file.
  const WRITE =
    /\.\s*set(?:TimeScale|Paused)\s*\(|harness\s*\.\s*(?:pause|resume|timeWarp)\s*\(/
  const blanked = (source: string): string =>
    source.replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`/g,
      (match) => match.replace(/[^\n]/g, ' '),
    )

  it('reads a glob or a URL as a string, not as a comment', () => {
    const source = blanked(
      "const a = import.meta.glob('./*.glb')\nclock.setPaused(true)\n" +
        "const b = 'https://x' ; clock.setTimeScale(2) /* */",
    )
    expect(source).toContain('clock.setPaused(true)')
    expect(source).toContain('clock.setTimeScale(2)')
  })

  it('is paused and warped from hud/time.ts alone, and the cinema', () => {
    const writers = globSync('**/*.{ts,tsx}', { cwd: root })
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .filter((file) => {
        const source = blanked(readFileSync(root + file, 'utf8'))
        return WRITE.test(source)
      })
      .sort()
    expect(writers).toEqual([
      'engine/GameEngine.ts',
      'hud/time.ts',
      'tour/executor.ts',
    ])
  })

  it('is not what the guide turns', () => {
    const source = blanked(readFileSync(root + 'tour/executor.ts', 'utf8'))
    const calls = [
      ...source.matchAll(/(\w+)\s*\.\s*set(?:TimeScale|Paused)\s*\(/g),
    ]
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls.map((call) => call[1]))).toEqual(new Set(['eye']))
  })
})
