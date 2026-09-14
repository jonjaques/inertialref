import { describe, expect, it } from 'vitest'
import { openSession } from '@inertialref/devtools'
import type { GuideCall, TourCameraMotion } from '@inertialref/protocol'
import { GuideExecutor, type GuideArrival } from './executor.ts'

function rig(ready?: () => boolean) {
  const session = openSession()
  session.harness.look('s:SOL/b:2', { ease: false })
  const arrivals: GuideArrival[] = []
  let takeovers = 0
  let now = 1000
  const executor = new GuideExecutor(session.harness, {
    now: () => now,
    onArrival: (arrival) => arrivals.push(arrival),
    onTakeover: () => {
      takeovers += 1
    },
    ready,
  })
  const settle = () => {
    for (let frame = 0; frame < 600; frame += 1)
      session.harness.observatory.sample(1 / 60)
    executor.poll()
  }
  return {
    session,
    eye: session.harness.observatory,
    executor,
    arrivals,
    takeovers: () => takeovers,
    settle,
    advance: (ms: number) => {
      now += ms
    },
    dispose: () => {
      executor.dispose()
      session.dispose()
    },
  }
}

const goTo = (
  subject: string,
  framing: string | null = null,
  motion: TourCameraMotion | null = null,
): GuideCall => ({ name: 'go_to', subject, framing, motion })

describe('the guide executor moves without blocking', () => {
  it('returns moving at once and publishes one arrival when the view is drawn', async () => {
    let ready = false
    const f = rig(() => ready)
    const hash = f.session.world.stateHash()
    const output = await f.executor.execute(goTo('Saturn', 'portrait', 'orbit'))
    expect(output).toMatchObject({
      status: 'moving',
      subject: 'Saturn',
      framing: 'portrait',
    })
    expect(f.executor.pending).toBe('go_to')
    f.settle()
    expect(f.arrivals).toHaveLength(0)
    ready = true
    f.executor.poll()
    expect(f.arrivals).toEqual([
      {
        tool: 'go_to',
        subject: 'Saturn',
        framing: 'portrait',
        viewRevision: f.eye.mutationRevision,
      },
    ])
    expect(f.eye.status().motion?.durationSeconds).toBe(30)
    f.executor.poll()
    expect(f.arrivals).toHaveLength(1)
    expect(f.takeovers()).toBe(0)
    expect(f.session.world.stateHash()).toBe(hash)
    f.dispose()
  })

  it('lets a second move replace the first and never publishes the stale arrival', async () => {
    const f = rig()
    await f.executor.execute(goTo('Titan'))
    expect(f.executor.pendingSubject).toBe('Titan')
    await f.executor.execute(goTo('Enceladus'))
    expect(f.executor.pendingSubject).toBe('Enceladus')
    f.settle()
    expect(f.arrivals.map((arrival) => arrival.subject)).toEqual(['Enceladus'])
    f.dispose()
  })

  it('treats the visitor moving the camera as a takeover that cancels the pending move', async () => {
    const f = rig()
    await f.executor.execute(goTo('Titan'))
    f.eye.zoom(2)
    f.executor.poll()
    expect(f.takeovers()).toBe(1)
    expect(f.executor.pending).toBeNull()
    f.settle()
    expect(f.arrivals).toHaveLength(0)
    f.dispose()
  })

  it('answers an unknown name with the nearest candidates rather than a guess', async () => {
    const f = rig()
    const output = await f.executor.execute(goTo('Saturnalia'))
    expect(output.status).toBe('unknown')
    expect(Array.isArray(output.candidates)).toBe(true)
    expect(f.executor.pending).toBeNull()
    const framing = await f.executor.execute(goTo('Saturn', 'from-the-rings'))
    expect(framing.status).toBe('rejected')
    expect(framing.framings).toContain('portrait')
    f.dispose()
  })
})

describe('every guide tool runs through the harness without touching the world', () => {
  it('executes the whole inventory headlessly with the canonical hash unchanged', async () => {
    const f = rig()
    const hash = f.session.world.stateHash()
    const run = (call: GuideCall) => f.executor.execute(call)

    expect(
      await run({ name: 'resolve_name', query: 'the moon' }),
    ).toMatchObject({
      status: 'ok',
      candidates: [{ name: 'Luna' }],
    })
    await run(goTo('Saturn', 'portrait'))
    f.settle()
    const view = await run({ name: 'describe_view' })
    expect(view.status).toBe('ok')
    expect(view.subject).toBe('Saturn')
    expect(view.framing).toBe('portrait')
    expect(
      (view.on_screen as { name: string; place: string }[]).find(
        (item) => item.name === 'Saturn',
      )?.place,
    ).toBe('center')

    const record = await run({
      name: 'read_subject',
      subject: 'Saturn',
      fields: null,
    })
    expect(record.status).toBe('ok')
    const facts = record.facts as { label: string; speech: string | null }[]
    expect(facts.some((fact) => fact.label === 'Equatorial radius')).toBe(true)
    expect(facts.some((fact) => fact.label === 'Saturn rings')).toBe(true)
    const radius = await run({
      name: 'read_subject',
      subject: 'Saturn',
      fields: ['radius'],
    })
    expect((radius.facts as unknown[]).length).toBe(1)

    const system = await run({
      name: 'list_subjects',
      scope: 'system',
      of: null,
      limit: null,
    })
    expect(
      (system.bodies as { name: string }[]).map((body) => body.name),
    ).toContain('Saturn')
    const moons = await run({
      name: 'list_subjects',
      scope: 'moons',
      of: 'Saturn',
      limit: null,
    })
    expect(
      (moons.moons as { name: string }[]).map((moon) => moon.name),
    ).toContain('Titan')
    const few = await run({
      name: 'list_subjects',
      scope: 'moons',
      of: 'Saturn',
      limit: 4,
    })
    expect((few.moons as unknown[]).length).toBe(4)
    const stars = await run({
      name: 'list_subjects',
      scope: 'nearby_stars',
      of: null,
      limit: 3,
    })
    expect(stars.status).toBe('ok')

    const adjusted = await run({
      name: 'adjust_view',
      azimuth_deg: 45,
      elevation_deg: 20,
      distance_radii: 6,
      zoom_factor: null,
    })
    expect(adjusted).toMatchObject({
      status: 'ok',
      azimuth_deg: 45,
      elevation_deg: 20,
      distance_radii: 6,
    })
    expect(f.takeovers()).toBe(0)

    expect(await run({ name: 'hold_view' })).toMatchObject({
      status: 'held',
      subject: 'Saturn',
    })

    const pair = await run({
      name: 'frame_pair',
      subject: 'Saturn',
      companion: 'Titan',
    })
    expect(pair.status).toBe('moving')
    f.settle()
    expect(f.arrivals.at(-1)?.tool).toBe('frame_pair')

    expect(
      await run({ name: 'stand_at', subject: 'Saturn', site: 'summit' }),
    ).toMatchObject({ status: 'rejected' })
    const stood = await run({
      name: 'stand_at',
      subject: 'Mars',
      site: 'summit',
    })
    expect(stood.status).toBe('moving')
    f.settle()
    expect(f.arrivals.at(-1)?.tool).toBe('stand_at')
    expect(
      await run({ name: 'look_around', heading_deg: 90, pitch_deg: 10 }),
    ).toMatchObject({ status: 'ok', heading_deg: 90, pitch_deg: 10 })
    expect(await run({ name: 'leave_surface' })).toMatchObject({
      status: 'moving',
    })
    f.settle()
    expect(f.arrivals.at(-1)?.tool).toBe('leave_surface')

    const held = await run({
      name: 'set_time',
      mode: 'set',
      instant: '2026-09-13T21:04:10Z',
      rate: null,
    })
    expect(held).toMatchObject({
      status: 'ok',
      mode: 'hold',
      picture_time: '2026-09-13T21:04:10Z',
    })
    expect(
      await run({ name: 'set_time', mode: 'rate', instant: null, rate: 100 }),
    ).toMatchObject({ status: 'ok', mode: 'rate', rate: 100 })
    expect(f.eye.heldTime).not.toBeNull()

    expect(
      await run({ name: 'linger', seconds: 10, reason: 'the rings' }),
    ).toEqual({ status: 'scheduled', seconds: 10 })

    const worlds = await run({
      name: 'find_worlds',
      query: {
        kinds: ['gas-giant'],
        starClasses: [],
        atmosphere: null,
        sea: null,
        rings: null,
        habitable: null,
        landable: null,
        moons: null,
        minRadius: null,
        maxRadius: null,
      },
      radius_light_years: 0.1,
      limit: 2,
    })
    expect(['ok', 'none']).toContain(worlds.status)
    expect(f.takeovers()).toBe(0)
    expect(f.session.world.stateHash()).toBe(hash)

    f.executor.dispose()
    expect(f.eye.heldTime).toBeNull()
    f.session.dispose()
  })
})

describe('a refused camera tool leaves the camera where the visitor left it', () => {
  it('refuses a pair from a surface without moving or raising the revision', async () => {
    const f = rig()
    // Standing is itself a camera mutation, so the poll absorbs it first: what
    // this test is about is the refusal that follows adding nothing.
    f.eye.stand('s:SOL/b:3')
    f.settle()
    f.executor.poll()
    const takeoversBefore = f.takeovers()
    const before = f.eye.mutationRevision
    const held = f.eye.target?.address
    // The subject is deliberately not the body being stood on: the commit this
    // is about is `eye.focus(subject)`, which a pair already targeting its
    // subject never reaches, so a test framing Mars from Mars proves nothing.
    const output = await f.executor.execute({
      name: 'frame_pair',
      subject: 'Saturn',
      companion: 'Titan',
    })
    expect(output.status).toBe('rejected')
    // The revision is the takeover signal: `track` raises it and *then* throws,
    // so a refusal that reaches it is indistinguishable from a drag, and the
    // next poll tells the visitor they took a camera they never touched.
    expect(f.eye.mutationRevision).toBe(before)
    expect(f.eye.target?.address).toBe(held)
    expect(f.eye.status().surface).not.toBeNull()
    f.executor.poll()
    expect(f.takeovers()).toBe(takeoversBefore)
    f.dispose()
  })

  it('still frames a pair that shares a system, star and moon included', async () => {
    // The other half of the same guard. It compares `dossier().system.id`, and
    // a star, a planet and a moon of one system have to agree on it or the
    // guard refuses the pairs it exists to allow.
    const f = rig()
    const pair = await f.executor.execute({
      name: 'frame_pair',
      subject: 'Mars',
      companion: 'Phobos',
    })
    expect(pair.status).toBe('moving')
    const withStar = await f.executor.execute({
      name: 'frame_pair',
      subject: 'Saturn',
      companion: 'Sol',
    })
    expect(withStar.status).toBe('moving')
    f.dispose()
  })

  it('answers a camera tool canceled in the turn its own poll sees the takeover', async () => {
    const f = rig()
    await f.executor.execute(goTo('Titan'))
    f.settle()
    const held = f.eye.target?.address
    f.eye.zoom(2)
    const after = f.eye.mutationRevision
    // The poll inside `execute` is what notices the gesture. Running the move
    // anyway takes the camera back and publishes an arrival for a call the
    // loop was told never ran.
    const output = await f.executor.execute(goTo('Saturn'))
    expect(output.status).toBe('canceled')
    expect(f.takeovers()).toBe(1)
    expect(f.executor.pending).toBeNull()
    expect(f.eye.target?.address).toBe(held)
    expect(f.eye.mutationRevision).toBe(after)
    f.settle()
    expect(f.arrivals.filter((a) => a.subject === 'Saturn')).toHaveLength(0)
    f.dispose()
  })

  it('still answers a query in that turn, because reading takes nothing', async () => {
    const f = rig()
    await f.executor.execute(goTo('Titan'))
    f.settle()
    f.eye.zoom(2)
    const output = await f.executor.execute({
      name: 'resolve_name',
      query: 'the moon',
    })
    expect(output.status).toBe('ok')
    f.dispose()
  })
})
