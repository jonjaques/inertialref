import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  GUIDE_CLIENT_EVENTS,
  type GuideClientEvent,
} from '@inertialref/protocol'
import { GuideChannel } from './channel.ts'
import { liveFake, read } from './liveFake.ts'

describe('the guide channel', () => {
  it('speaks every verb as an event the allow list admits', async () => {
    const fake = liveFake()
    const channel = new GuideChannel(fake.live)
    channel.note('Current view: Saturn.')
    channel.ask('What is that bright one?')
    channel.answer('call_1', { status: 'ok' })
    channel.respond()
    channel.instruct('Introduce yourself.')
    channel.comment('Begin.')
    channel.think('The visitor is looking at Saturn.')
    await channel.mute(true)
    await channel.mute(false)
    channel.close()
    const types = fake.sent.map((event) => event.type)
    expect(new Set(types)).toEqual(new Set(GUIDE_CLIENT_EVENTS))
    expect(read.developer(fake.sent)).toEqual(['Current view: Saturn.'])
    expect(read.outputs(fake.sent)).toEqual([
      { callId: 'call_1', output: { status: 'ok' } },
    ])
    // Muting is both directions on the browser's side too.
    expect(fake.microphone).toEqual([true, false])
    expect(fake.guideAudio).toEqual([true, false])
  })

  it('returns the stamped id an acknowledgment is matched by', () => {
    const fake = liveFake()
    const channel = new GuideChannel(fake.live)
    const id = channel.instruct('x')
    expect(fake.sent.at(-1)?.event_id).toBe(id)
  })

  it('swallows only the advisory verbs on a closed connection', () => {
    const fake = liveFake()
    const channel = new GuideChannel(fake.live)
    fake.live.stop()
    expect(() => channel.think('x')).not.toThrow()
    expect(() => channel.close()).not.toThrow()
    expect(() => channel.instruct('x')).toThrow(/not open/)
    expect(() => channel.respond()).toThrow(/not open/)
  })
})

describe('the fake provider', () => {
  it('refuses an event off the allow list, as the real connection does', () => {
    const fake = liveFake()
    // The type refuses it first …
    // @ts-expect-error `session.update` is not a client event the guide may send.
    const update: GuideClientEvent = { type: 'session.update', session: {} }
    // … and a cast past the type is refused on the wire, so a test of a
    // misspelled event fails here rather than in a billed session.
    expect(() => fake.live.send(update)).toThrow(
      'The guide may not send session.update.',
    )
    expect(fake.sent).toEqual([])
  })

  it('acknowledges appends and mutes by the client event id, and ends on close', async () => {
    const fake = liveFake()
    const heard: Record<string, unknown>[] = []
    fake.listen((event) => heard.push(event))
    const channel = new GuideChannel(fake.live)
    const id = channel.instruct('x')
    void channel.mute(true)
    channel.close()
    await Promise.resolve()
    expect(heard).toEqual([
      { type: 'session.instructions.appended', client_event_id: id },
      {
        type: 'session.input_audio.muted',
        client_event_id: fake.sent[1]!.event_id,
      },
      {
        type: 'session.closed',
        reason: 'close_requested',
        usage: { seconds: 42 },
      },
    ])
  })
})

describe('the provider vocabulary', () => {
  it('is named only inside the adapter', () => {
    /*
     * The channel, the loop and the transport are the adapter; the fake and
     * the tests speak the provider on purpose. Anywhere else, an event name
     * is a second place that has to agree with the provider's.
     */
    const root = fileURLToPath(new URL('./', import.meta.url))
    const ADAPTER = new Set([
      'channel.ts',
      'loop.ts',
      'media.ts',
      'liveFake.ts',
    ])
    // No `g`: `test` on a global pattern resumes at `lastIndex`, file to file.
    const EVENT = /['"`](?:session|response)\.[a-z_]+(?:\.[a-z_]+)*['"`]/
    const naming = globSync('*.{ts,tsx}', { cwd: root })
      .filter((file) => !/\.test\.tsx?$/.test(file) && !ADAPTER.has(file))
      .filter((file) => EVENT.test(readFileSync(root + file, 'utf8')))
    expect(naming).toEqual([])
  })
})
