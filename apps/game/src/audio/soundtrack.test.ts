import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SoundtrackCatalog,
  SoundtrackCategory,
  SoundtrackTrack,
} from '@inertialref/protocol'
import {
  broken,
  FakeContext,
  FakeElement,
  policy,
  settle,
} from './fakeAudio.ts'
import {
  DEFAULT_SETTINGS,
  type Presence,
  Soundtrack,
  type SoundtrackHost,
  type SoundtrackSettings,
} from './soundtrack.ts'
import { createSoundtrackStore } from './soundtrackStore.ts'

const AAC = 'audio/mp4; codecs="mp4a.40.2"'

const track = (
  id: string,
  category: SoundtrackCategory = 'ambient',
): SoundtrackTrack => ({
  id,
  title: id.toUpperCase(),
  artist: 'Artist',
  performer: null,
  release: 'Release',
  year: 2020,
  category,
  license: 'cc-by-4.0',
  credit: `“${id}” by Artist.`,
  licensor: 'https://example.test/',
  modified: 'level unchanged, re-encoded as AAC and Opus',
  duration: 300,
  cues: { start: 1, end: 290 },
  loudness: { integrated: -18, truePeak: -2 },
  contour: Array.from({ length: 64 }, () => -20),
  files: [
    {
      name: `music/${id}.0123456789.m4a`,
      type: AAC,
      bytes: 1000,
      sha256: 'a'.repeat(64),
      bitrate: 256_000,
    },
  ],
})

const CATALOG: SoundtrackCatalog = {
  version: 1,
  generated: '2026-11-06',
  target: { integrated: -18, truePeak: -1 },
  tracks: [track('a'), track('b'), track('c'), track('d', 'lofi')],
}

const url = (id: string): string => `/media/music/${id}.0123456789.m4a`

const HERE: Presence = { here: true, scene: false, away: false }

function rig({
  settings = {},
  resume = null,
  random = () => 0.5,
}: {
  settings?: Partial<SoundtrackSettings>
  resume?: { id: string; at: number } | null
  random?: () => number
} = {}) {
  const store = createSoundtrackStore()
  const context = new FakeContext()
  const elements: FakeElement[] = []
  const state = { online: true, resume }
  const kept = new Set<string>()
  const host: SoundtrackHost = {
    createContext: () => context as unknown as AudioContext,
    createElement: () => {
      const element = new FakeElement()
      elements.push(element)
      return element as unknown as HTMLAudioElement
    },
    canPlay: (type) => (type === AAC ? 'probably' : ''),
    random,
    online: () => state.online,
    kept: (name) => kept.has(name),
    readResume: () => state.resume,
    writeResume: (point) => {
      state.resume = point
    },
  }
  const player = new Soundtrack(CATALOG, store, host)
  player.configure({ ...DEFAULT_SETTINGS, shuffle: false, ...settings })
  const playback = () => store.getState().playback
  /** The element holding the current track. */
  const active = (): FakeElement =>
    elements.find((element) => element.src === url(playback().trackId ?? ''))!
  /**
   * The gain a deck routes `element` through. The mixer's five buses are
   * built first, then each deck's element and its gain, in that order.
   */
  const gainOf = (element: FakeElement) =>
    context.gains[5 + elements.indexOf(element)]!.gain
  return {
    player,
    store,
    context,
    elements,
    state,
    kept,
    playback,
    active,
    gainOf,
  }
}

/** A rig that is playing its first track. */
async function playing(options: Parameters<typeof rig>[0] = {}) {
  const r = rig(options)
  r.player.setPresence(HERE)
  await settle()
  r.player.unlock()
  await settle()
  return r
}

beforeEach(() => {
  vi.useFakeTimers()
  broken.clear()
  policy.refuse = false
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the soundtrack', () => {
  it('stays silent and builds nothing until the game wants music', () => {
    const { player, playback, elements } = rig()
    player.setPresence({ here: false, scene: false, away: false })
    expect(playback().status).toBe('off')
    expect(elements).toHaveLength(0)
  })

  it('loads the first track while it waits for a gesture, and plays nothing', async () => {
    const { player, playback, elements } = rig()
    player.setPresence(HERE)
    await settle()
    expect(playback().status).toBe('waiting')
    expect(playback().trackId).toBe('a')
    expect(elements[0]!.src).toBe(url('a'))
    expect(elements.every((element) => element.paused)).toBe(true)
  })

  it('starts on the first gesture, fading up from silence, and raises the card', async () => {
    const { playback, active, context, store } = await playing()
    expect(context.state).toBe('running')
    expect(playback().status).toBe('playing')
    expect(active().paused).toBe(false)
    expect(store.getState().card?.trackId).toBe('a')
  })

  it('waits for the next gesture when the browser refuses to play', async () => {
    policy.refuse = true
    const { playback } = await playing()
    expect(playback().status).toBe('waiting')
  })

  it('loads the next track ahead of time and crossfades before the music ends', async () => {
    const { elements, active, playback } = await playing()
    const first = active()
    first.advance(265) // past cues.end − fade − 20 s
    await settle()
    const idle = elements.find((element) => element !== first)!
    expect(idle.src).toBe(url('b'))
    expect(idle.paused).toBe(true)

    first.advance(20) // 285 s: inside the six-second fade before 290
    await settle()
    expect(playback().trackId).toBe('b')
    expect(playback().crossfading).toBe(true)
    expect(idle.paused).toBe(false)

    vi.advanceTimersByTime(6_200)
    expect(first.src).toBe('')
    expect(playback().crossfading).toBe(false)
  })

  it('fades quickly on a skip', async () => {
    const { player, playback, context } = await playing()
    player.next()
    await settle()
    expect(playback().trackId).toBe('b')
    const fades = context.gains.flatMap((gain) => gain.gain.calls)
    expect(fades.some((call) => /over 1\.2$/.test(call))).toBe(true)
  })

  it('passes over a track that will not load', async () => {
    const { player, playback } = await playing()
    broken.set(url('b'), 4)
    player.next()
    await settle(16)
    expect(playback().trackId).toBe('c')
    expect(playback().status).toBe('playing')
  })

  it('says why when no track can play', async () => {
    for (const id of ['a', 'b', 'c', 'd']) broken.set(url(id), 4)
    const { player, playback } = rig()
    player.setPresence(HERE)
    player.unlock()
    await settle(40)
    expect(playback().status).toBe('unavailable')
    expect(playback().reason).toBe('the soundtrack is not served here')
  })

  it('plays only kept tracks offline, and says so when none are kept', async () => {
    const offline = rig()
    offline.state.online = false
    offline.kept.add('music/c.0123456789.m4a')
    offline.player.configure({ ...DEFAULT_SETTINGS, shuffle: false })
    offline.player.setPresence(HERE)
    offline.player.unlock()
    await settle()
    expect(offline.playback().trackId).toBe('c')

    const empty = rig()
    empty.state.online = false
    empty.player.configure({ ...DEFAULT_SETTINGS, shuffle: false })
    empty.player.setPresence(HERE)
    await settle()
    expect(empty.playback().status).toBe('unavailable')
    expect(empty.playback().reason).toBe(
      'offline, and no track is kept on this device',
    )
  })

  it('steps aside for a scene with a track of its own, and comes back', async () => {
    const { player, active, playback } = await playing()
    const element = active()
    player.setPresence({ ...HERE, scene: true })
    expect(playback().status).toBe('off')
    vi.advanceTimersByTime(1_300)
    expect(element.paused).toBe(true)
    player.setPresence(HERE)
    await settle()
    expect(element.paused).toBe(false)
    expect(playback().status).toBe('playing')
  })

  /*
   * A voice is not a scene: the music stays playing, held down, and comes
   * back to exactly the listener's level — the duck is its own gain, so the
   * music level the preference set is never written.
   */
  it('steps down under a voice and back up, without pausing', async () => {
    const { player, active, playback, context } = await playing()
    const music = context.gains[0]!
    const duck = music.outputs[0]!
    const level = music.gain.value
    player.setVoice(true)
    expect(duck.gain.value).toBeCloseTo(0.25)
    expect(playback().ducked).toBe(true)
    vi.advanceTimersByTime(2_000)
    expect(active().paused).toBe(false)
    expect(playback().status).toBe('playing')
    player.setVoice(false)
    expect(duck.gain.value).toBeCloseTo(1)
    expect(playback().ducked).toBe(false)
    expect(music.gain.value).toBe(level)
  })

  it('ducks a graph built after the voice went live', async () => {
    const { player, context } = rig()
    player.setVoice(true)
    player.setPresence(HERE)
    await settle()
    const duck = context.gains[0]!.outputs[0]!
    expect(duck.gain.value).toBeCloseTo(0.25)
  })

  it('keeps a listener’s pause through a scene', async () => {
    const { player, active, playback } = await playing()
    player.pause()
    vi.advanceTimersByTime(400)
    player.setPresence({ ...HERE, scene: true })
    player.setPresence(HERE)
    await settle()
    expect(active().paused).toBe(true)
    expect(playback().status).toBe('paused')
    player.play()
    await settle()
    expect(active().paused).toBe(false)
  })

  it('lets the playing track finish when it is switched off, and never brings it back', async () => {
    const { player, active, playback } = await playing()
    const element = active()
    player.configure({ ...DEFAULT_SETTINGS, shuffle: false, disabled: ['a'] })
    await settle()
    expect(element.paused).toBe(false)
    expect(playback().trackId).toBe('a')
    expect(playback().upcoming).not.toContain('a')
  })

  it('restarts the track after a few seconds, and goes back before that', async () => {
    const { player, active, playback } = await playing()
    player.next()
    await settle()
    const second = active()
    second.advance(30)
    player.previous()
    expect(second.currentTime).toBe(1) // cues.start
    second.currentTime = 2
    player.previous()
    await settle()
    expect(playback().trackId).toBe('a')
  })

  it('holds at the end of the playlist when repeat is off, and says so', async () => {
    const { player, playback, active } = await playing({
      settings: { repeat: 'off', order: ['d', 'c', 'b', 'a'] },
    })
    expect(playback().trackId).toBe('d')
    for (let i = 0; i < 3; i += 1) {
      player.next()
      await settle()
    }
    expect(playback().trackId).toBe('a')
    vi.advanceTimersByTime(1_400) // the last skip's fade completes
    // The last track reaches its fade with nothing after it.
    const last = active()
    last.advance(285)
    await settle()
    vi.advanceTimersByTime(1_300)
    expect(last.paused).toBe(true)
    expect(playback().status).toBe('paused')
    expect(playback().reason).toBe('the playlist has ended')
    // Play from there: the track plays out and stops, rather than waiting on
    // a crossfade that never began.
    player.play()
    await settle()
    expect(last.paused).toBe(false)
    last.emit('ended')
    expect(playback().trackId).toBe('a')
  })

  it('resumes a reload where it left off', async () => {
    const { elements, playback } = await playing({
      resume: { id: 'c', at: 120 },
    })
    expect(playback().trackId).toBe('c')
    expect(elements[0]!.currentTime).toBe(120)
  })

  it('applies the levels and the mono switch to the graph', async () => {
    const { player, context } = await playing()
    player.configure({
      ...DEFAULT_SETTINGS,
      shuffle: false,
      master: 0.5,
      music: 1,
      mono: true,
    })
    const master = context.gains.find((gain) =>
      gain.outputs.includes(context.destination),
    )!
    expect(master.gain.value).toBeCloseTo(0.25)
    expect(master.channelCount).toBe(1)
  })

  it('fades back up when a pause is undone inside its own fade', async () => {
    const { player, active, playback, gainOf } = await playing()
    const element = active()
    player.pause()
    vi.advanceTimersByTime(100)
    expect(element.paused).toBe(false)
    player.play()
    await settle()
    vi.advanceTimersByTime(1_000)
    expect(element.paused).toBe(false)
    expect(gainOf(element).value).toBe(1)
    expect(playback().status).toBe('playing')
  })

  it('pauses a track that is still loading', async () => {
    const { player, playback, elements } = rig()
    player.setPresence(HERE)
    player.unlock()
    expect(playback().status).toBe('loading')
    player.toggle()
    await settle()
    expect(elements.every((element) => element.paused)).toBe(true)
    expect(playback().status).toBe('paused')
  })

  it('raises the card when a track begins, not when it resumes', async () => {
    const { player, store } = await playing()
    const serial = store.getState().card?.serial
    player.pause()
    vi.advanceTimersByTime(400)
    player.play()
    await settle()
    expect(store.getState().card?.serial).toBe(serial)
  })

  it('plays a repeated track again and again, not twice', async () => {
    const { active, playback } = await playing({ settings: { repeat: 'one' } })
    for (let round = 0; round < 3; round += 1) {
      const element = active()
      element.advance(285 - element.currentTime)
      await settle()
      vi.advanceTimersByTime(6_200)
      expect(playback().trackId).toBe('a')
      expect(active()).not.toBe(element)
      expect(active().paused).toBe(false)
    }
  })

  it('plays a track picked near the end of another, not the one after it', async () => {
    const { player, active, playback } = await playing()
    const first = active()
    first.advance(270) // inside the preload window of a's ending
    await settle()
    player.select('d')
    // The outgoing deck keeps reporting while the pick loads.
    first.advance(0.25)
    await settle()
    expect(playback().trackId).toBe('d')
    expect(active().paused).toBe(false)
  })

  it('takes a second skip inside the first one’s fade', async () => {
    const { player, playback } = await playing()
    player.next()
    await settle()
    vi.advanceTimersByTime(1_000)
    player.next()
    // The first skip's release comes due while the second one loads.
    vi.advanceTimersByTime(400)
    await settle()
    expect(playback().trackId).toBe('c')
    expect(playback().status).toBe('playing')
  })

  it('passes over a preloaded track that fails at its transition', async () => {
    const { active, playback } = await playing()
    broken.set(url('b'), 4)
    const first = active()
    first.advance(265) // the preload of b starts
    first.advance(20) // and the fade is due before it has answered
    await settle(16)
    expect(playback().trackId).toBe('c')
    expect(playback().status).toBe('playing')
  })

  it('crossfades into the track it preloaded at the end of a shuffled cycle', async () => {
    let state = 3
    const random = (): number => {
      state = (state * 48_271) % 2_147_483_647
      return state / 2_147_483_647
    }
    const { player, active, elements, playback } = await playing({
      settings: { shuffle: true },
      random,
    })
    // Spend the cycle, so the next track comes from a fresh draw.
    for (let i = 0; i < 3; i += 1) {
      player.next()
      await settle()
      vi.advanceTimersByTime(1_400)
    }
    expect(playback().upcoming).toEqual([])
    const playingNow = active()
    playingNow.advance(270)
    await settle()
    const idle = elements.find((element) => element !== playingNow)!
    const preloaded = idle.src
    expect(preloaded).not.toBe('')
    playingNow.advance(15)
    await settle()
    expect(active()).toBe(idle)
    expect(idle.src).toBe(preloaded)
  })
})
