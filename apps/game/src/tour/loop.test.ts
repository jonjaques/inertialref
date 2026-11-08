import { describe, expect, it, vi } from 'vitest'
import type { GuideCall, GuideToolOutput } from '@inertialref/protocol'
import { GuideChannel } from './channel.ts'
import { liveFake, provider, read } from './liveFake.ts'
import { GuideLoop } from './loop.ts'

function rig() {
  const fake = liveFake()
  let now = 0
  const executed: GuideCall[] = []
  const execute = vi.fn(async (call: GuideCall): Promise<GuideToolOutput> => {
    executed.push(call)
    return { status: 'moving', subject: 'Saturn' }
  })
  const delegations = vi.fn()
  const closed = vi.fn()
  const errors = vi.fn()
  const fatal = vi.fn()
  const loop = new GuideLoop(new GuideChannel(fake.live), {
    now: () => now,
    execute,
    onDelegation: delegations,
    onClosed: closed,
    onError: errors,
    onFatal: fatal,
  })
  fake.listen((event) => loop.receive(event))
  const call = (
    id: string,
    name = 'go_to',
    args = '{"subject":"Saturn","framing":null,"motion":null}',
  ) => fake.emit(provider.functionCall(id, name, args))
  const created = (id: string) => fake.emit(provider.responseCreated(id))
  const completed = (id: string, usage?: Record<string, unknown>) =>
    fake.emit(provider.responseCompleted(id, usage ?? null))
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return {
    loop,
    fake,
    sent: fake.sent,
    executed,
    execute,
    delegations,
    closed,
    errors,
    fatal,
    call,
    created,
    completed,
    settle,
    advance: (ms: number) => {
      now += ms
    },
    outputs: () => read.outputs(fake.sent),
    creates: () => read.creates(fake.sent),
    developer: () => read.developer(fake.sent),
  }
}

describe('the tool loop over the data channel', () => {
  it('executes a function call once, answers it, and continues the response', async () => {
    const f = rig()
    f.created('resp_1')
    f.call('call_1')
    f.call('call_1')
    await f.settle()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.executed[0]).toEqual({
      name: 'go_to',
      subject: 'Saturn',
      framing: null,
      motion: null,
    })
    expect(f.outputs()).toHaveLength(1)
    expect(f.outputs()[0]).toEqual({
      callId: 'call_1',
      output: { status: 'moving', subject: 'Saturn' },
    })
    // The continuation waits for the response to finish emitting: another
    // call may still be on its way.
    expect(f.creates()).toBe(0)
    expect(f.loop.inFlight).toBe(true)
    f.completed('resp_1')
    expect(f.creates()).toBe(1)
    expect(f.loop.inFlight).toBe(true)
    f.created('resp_2')
    f.completed('resp_2')
    expect(f.loop.inFlight).toBe(false)
  })

  it('answers a call the schema refuses with an error and never runs it', async () => {
    const f = rig()
    f.created('resp_1')
    f.call('call_bad', 'go_to', '{"subject":"Saturn","address":"s:SOL/b:5"}')
    f.call('call_unknown', 'run_javascript', '{}')
    await f.settle()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.outputs()).toHaveLength(2)
    for (const { output } of f.outputs()) expect(output.status).toBe('error')
  })

  it('prompts the backend only while idle and the visitor is quiet', async () => {
    const f = rig()
    expect(f.loop.prompt('Arrived: Saturn.')).toBe(true)
    expect(f.creates()).toBe(1)
    f.created('resp_1')
    expect(f.loop.prompt('Arrived: Titan.')).toBe(false)
    expect(f.creates()).toBe(1)
    f.completed('resp_1')
    f.fake.emit(provider.visitorSaid('actually'))
    expect(f.loop.visitorSpeaking).toBe(true)
    expect(f.loop.prompt('Arrived: Enceladus.')).toBe(false)
    f.advance(1500)
    expect(f.loop.visitorSpeaking).toBe(false)
    expect(f.loop.prompt('The visitor has looked quietly.')).toBe(true)
    expect(f.creates()).toBe(2)
    expect(f.developer()).toHaveLength(4)
  })

  it('runs the queries of one response together, one move at most, and continues once all are answered', async () => {
    const f = rig()
    let release: (() => void) | null = null
    f.execute.mockImplementation(async (call: GuideCall) => {
      f.executed.push(call)
      if (call.name === 'read_subject')
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return { status: 'moving', subject: 'Saturn' }
    })
    f.created('resp_1')
    f.call('call_a', 'read_subject', '{"subject":"Titan","fields":null}')
    f.call('call_b', 'describe_view', '{}')
    f.call('call_c', 'go_to')
    f.call(
      'call_d',
      'go_to',
      '{"subject":"Titan","framing":null,"motion":null}',
    )
    await f.settle()
    // The second query ran without waiting for the first; the second move
    // was refused without running.
    expect(f.executed.map((call) => call.name)).toEqual([
      'read_subject',
      'describe_view',
      'go_to',
    ])
    const ids = () => f.outputs().map((o) => o.callId)
    expect(ids()).toEqual(['call_d', 'call_b', 'call_c'])
    expect(f.outputs()[0]!.output).toMatchObject({ status: 'rejected' })
    expect(f.creates()).toBe(0)
    f.completed('resp_1')
    expect(f.creates()).toBe(0)
    release!()
    await f.settle()
    expect(ids()).toEqual(['call_d', 'call_b', 'call_c', 'call_a'])
    expect(f.creates()).toBe(1)
    expect(f.loop.inFlight).toBe(true)
  })

  it('starts a response on queued state only once the chain has closed', async () => {
    const f = rig()
    f.created('resp_1')
    expect(f.loop.prompt('Arrived: Europa, standing at the pole.')).toBe(false)
    expect(f.loop.start()).toBe(false)
    expect(f.creates()).toBe(0)
    f.completed('resp_1')
    expect(f.loop.start()).toBe(true)
    expect(f.creates()).toBe(1)
    expect(f.developer()).toHaveLength(1)
  })

  it('counts usage once per response and reads voice seconds from the session', () => {
    const f = rig()
    f.created('resp_1')
    const usage = {
      input_tokens: 1875,
      input_tokens_details: { cached_tokens: 1619 },
      output_tokens: 28,
    }
    f.completed('resp_1', usage)
    f.completed('resp_1', usage)
    expect(f.loop.usage).toMatchObject({
      responses: 1,
      inputTokens: 1875,
      cachedTokens: 1619,
      outputTokens: 28,
    })
    f.fake.emit(provider.usage(41))
    f.fake.emit(provider.usage(39))
    expect(f.loop.usage.voiceSeconds).toBe(41)
    f.fake.emit(provider.closed('close_requested', 60))
    expect(f.loop.usage.voiceSeconds).toBe(60)
    expect(f.loop.closed?.reason).toBe('close_requested')
    expect(f.closed).toHaveBeenCalledWith('close_requested')
  })

  it('cancels pending calls with a canceled output and continues the chain', async () => {
    let release: (() => void) | null = null
    const f = rig()
    f.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ status: 'ok', matches: [] } as GuideToolOutput)
        }),
    )
    f.created('resp_1')
    f.call('call_slow', 'describe_view', '{}')
    await f.settle()
    expect(f.loop.pendingCalls).toBe(1)
    f.loop.cancelPending('The visitor took the camera.')
    expect(f.loop.pendingCalls).toBe(0)
    expect(f.outputs()[0]!.output).toMatchObject({ status: 'canceled' })
    release!()
    await f.settle()
    expect(f.outputs()).toHaveLength(1)
  })

  it('matches acknowledgments to the event that asked and notices delegations', async () => {
    const f = rig()
    const pending = f.loop.waitForAck('guide-9', 1000)
    f.fake.emit(provider.ack('session.instructions.appended', 'guide-9'))
    expect(await pending).toBe(true)
    f.fake.emit(provider.delegation())
    expect(f.delegations).toHaveBeenCalledOnce()
  })
})

/*
 * The paths the provider can take that the happy path never shows. Each
 * test is one adversarial mode of the fake, and each proves either that the
 * chain closes — so the next arrival can prompt — or that the session ends
 * with a message, without a provider.
 */
describe('the loop recovers', () => {
  it('reads a refused continuation as a closed chain, not a chain in flight for good', async () => {
    const f = rig()
    f.fake.refuse('response.create', 'rate_limit_exceeded')
    expect(f.loop.prompt('Arrived: Saturn.')).toBe(true)
    expect(f.loop.inFlight).toBe(true)
    await f.settle()
    expect(f.loop.inFlight).toBe(false)
    expect(f.errors).toHaveBeenCalledWith(
      'rate_limit_exceeded',
      expect.any(String),
    )
    expect(f.fatal).not.toHaveBeenCalled()
    f.fake.refuse('response.create', null)
    expect(f.loop.prompt('Arrived: Titan.')).toBe(true)
    expect(f.creates()).toBe(2)
  })

  it('gives up on a continuation nothing answers within thirty seconds', () => {
    const f = rig()
    expect(f.loop.prompt('Arrived: Saturn.')).toBe(true)
    f.advance(29_000)
    expect(f.loop.inFlight).toBe(true)
    f.advance(1_500)
    expect(f.loop.inFlight).toBe(false)
    expect(f.loop.prompt('Arrived: Titan.')).toBe(true)
  })

  it('abandons a response that never completes', () => {
    const f = rig()
    f.created('resp_1')
    f.advance(89_000)
    expect(f.loop.inFlight).toBe(true)
    f.advance(2_000)
    expect(f.loop.inFlight).toBe(false)
    // Its late completion is not a continuation.
    f.completed('resp_1')
    expect(f.creates()).toBe(0)
  })

  it('ends the chain on a failed response and never continues it', async () => {
    const f = rig()
    f.created('resp_1')
    f.call('call_1')
    await f.settle()
    f.fake.emit(provider.responseFailed('resp_1', 'server_error'))
    expect(f.creates()).toBe(0)
    expect(f.loop.inFlight).toBe(false)
    expect(f.errors).toHaveBeenCalledWith('server_error', expect.any(String))
    // A call the failed response left unanswered is dropped, not run late.
    const g = rig()
    g.created('resp_1')
    g.fake.emit(provider.responseFailed('resp_1'))
    g.call('call_late')
    await g.settle()
    expect(g.loop.pendingCalls).toBe(0)
    expect(g.loop.inFlight).toBe(false)
  })

  it('re-prompts once for a terminal response cut off at the token cap, then stops', () => {
    const f = rig()
    f.created('resp_1')
    f.fake.emit(provider.message('Saturn is'))
    f.fake.emit(provider.responseIncomplete('resp_1', 'max_output_tokens'))
    expect(f.creates()).toBe(1)
    expect(f.developer().at(-1)).toMatch(/cut off/)
    f.created('resp_2')
    f.fake.emit(provider.responseIncomplete('resp_2', 'max_output_tokens'))
    expect(f.creates()).toBe(1)
    expect(f.loop.inFlight).toBe(false)
    expect(f.errors).toHaveBeenCalledWith(
      'max_output_tokens',
      expect.any(String),
    )
    // A normal completion arms the re-prompt again.
    f.created('resp_3')
    f.completed('resp_3')
    f.created('resp_4')
    f.fake.emit(provider.responseIncomplete('resp_4', 'max_output_tokens'))
    expect(f.creates()).toBe(2)
  })

  it('continues a response whose calls were answered even when it ended incomplete', async () => {
    const f = rig()
    f.created('resp_1')
    f.call('call_1')
    await f.settle()
    f.fake.emit(provider.responseIncomplete('resp_1', 'max_output_tokens'))
    expect(f.creates()).toBe(1)
    expect(f.developer()).toHaveLength(0)
  })

  it('holds a call that arrives before its response is created, and continues once it completes', async () => {
    const f = rig()
    f.call('call_early')
    await f.settle()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.outputs()).toHaveLength(1)
    // Answered, but nothing to continue yet: the response is not known.
    expect(f.creates()).toBe(0)
    f.created('resp_1')
    expect(f.creates()).toBe(0)
    f.completed('resp_1')
    expect(f.creates()).toBe(1)
  })

  it('attributes a call to its own delegation, never to whichever response is open', async () => {
    const f = rig()
    f.fake.emit(provider.responseCreated('resp_a', 'item_a'))
    f.fake.emit(provider.responseCreated('resp_b', 'item_b'))
    f.fake.emit(
      provider.functionCall('call_b', 'describe_view', '{}', 'item_b'),
    )
    await f.settle()
    f.fake.emit(provider.responseCompleted('resp_b', null, 'item_b'))
    expect(f.creates()).toBe(1)
    f.fake.emit(provider.responseCreated('resp_b2', 'item_b'))
    f.fake.emit(provider.responseCompleted('resp_b2', null, 'item_b'))
    // The other delegation's response is still open and was not continued
    // by an output that was never its own.
    expect(f.loop.inFlight).toBe(true)
    f.fake.emit(provider.responseCompleted('resp_a', null, 'item_a'))
    expect(f.creates()).toBe(1)
    expect(f.loop.inFlight).toBe(false)
  })

  it('does nothing for a duplicate or unknown completion', async () => {
    const f = rig()
    f.created('resp_1')
    f.call('call_1')
    await f.settle()
    f.completed('resp_1')
    f.completed('resp_1')
    f.fake.emit(
      provider.responseCompleted('resp_never_created', null, 'item_9'),
    )
    expect(f.creates()).toBe(1)
  })

  it('keeps the rows of live work when it prunes, and remembers what it has finished', async () => {
    const f = rig()
    // Seventy chains: a call, its continuation, the terminal response.
    for (let i = 1; i <= 70; i++) {
      f.created(`resp_${i}`)
      f.call(`call_${i}`, 'describe_view', '{}')
      await f.settle()
      f.completed(`resp_${i}`)
      f.created(`term_${i}`)
      f.completed(`term_${i}`)
    }
    expect(f.creates()).toBe(70)
    expect(f.loop.inFlight).toBe(false)
    // A redelivered completion of a pruned response starts nothing.
    f.completed('resp_1')
    expect(f.creates()).toBe(70)
    // A redelivered call of a pruned response runs nothing.
    f.call('call_1', 'describe_view', '{}')
    await f.settle()
    expect(f.execute).toHaveBeenCalledTimes(70)
    // A response holding an unanswered call survives seventy completions after it.
    let release: (() => void) | null = null
    f.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 'ok' } as GuideToolOutput)
        }),
    )
    f.created('resp_slow')
    f.call('call_slow', 'describe_view', '{}')
    await f.settle()
    f.completed('resp_slow')
    for (let i = 71; i <= 140; i++) {
      f.fake.emit(provider.responseCreated(`resp_${i}`, 'item_other'))
      f.fake.emit(provider.responseCompleted(`resp_${i}`, null, 'item_other'))
    }
    const before = f.creates()
    release!()
    await f.settle()
    expect(f.creates()).toBe(before + 1)
  })

  it('survives an answer the transport refuses, and the camera queue runs on', async () => {
    const f = rig()
    f.created('resp_1')
    f.call('call_1')
    f.fake.live.stop()
    await f.settle()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.errors).toHaveBeenCalledWith('send-failed', expect.any(String))
    f.fake.listen((event) => f.loop.receive(event))
    // The next response's move runs on the same serialized queue.
    f.created('resp_2')
    f.call('call_2')
    await f.settle()
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(f.outputs().map((o) => o.callId)).toEqual(['call_2'])
  })

  it('ends the session on an error the browser cannot repair', () => {
    const f = rig()
    f.fake.emit(provider.error('responses_validation_failed'))
    expect(f.fatal).toHaveBeenCalledWith(expect.stringMatching(/configuration/))
    f.fake.emit(provider.error('insufficient_quota'))
    expect(f.fatal).toHaveBeenCalledWith(expect.stringMatching(/budget/))
    f.fake.emit(provider.error('something_else'))
    expect(f.fatal).toHaveBeenCalledTimes(2)
    expect(f.errors).toHaveBeenCalledTimes(3)
  })
})
