import { describe, expect, it } from 'vitest'
import { SpeechClock } from './clock.ts'

function rig() {
  let now = 0
  const clock = new SpeechClock({ now: () => now, floor: 0.01, quietMs: 1500 })
  const run = (level: number, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      now += 100
      clock.sample(level)
    }
  }
  return { clock, run, now: () => now }
}

describe('the speech clock', () => {
  it('ends a beat only after speech that began after the words returned has gone quiet', async () => {
    const f = rig()
    // Filler before the terminal response must not count as the beat.
    f.run(0.05, 1000)
    f.run(0, 2000)
    const since = f.now()
    const beat = f.clock.waitForBeat({ since })
    f.run(0, 1000)
    f.run(0.05, 3000)
    expect(f.clock.speaking).toBe(true)
    f.run(0, 1400)
    let settled = false
    void beat.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    f.run(0, 200)
    expect(await beat).toBe('spoken')
  })
  it('rides out the pauses the voice leaves between sentences at its defaults', async () => {
    // The recorded narrations hold their breath for up to 2.3 s between
    // sentences; a beat that ended inside one continued the tour over the
    // guide's own words. Soft tails read 0.005 and silence reads zero.
    let now = 0
    const clock = new SpeechClock({ now: () => now })
    const run = (level: number, ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 100) {
        now += 100
        clock.sample(level)
      }
    }
    const beat = clock.waitForBeat({ since: now })
    run(0.05, 2000)
    run(0, 2300)
    run(0.005, 1500)
    let settled = false
    void beat.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(clock.speaking).toBe(true)
    run(0, 2600)
    expect(await beat).toBe('spoken')
  })
  it('gives up on a beat nothing speaks and reports cancellation', async () => {
    const f = rig()
    const silent = f.clock.waitForBeat({ since: f.now(), startTimeoutMs: 2000 })
    f.run(0, 2100)
    expect(await silent).toBe('silent')
    const canceled = f.clock.waitForBeat({ since: f.now() })
    f.clock.cancel()
    expect(await canceled).toBe('canceled')
  })
})
