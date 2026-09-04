import { getLogger, getTimer } from '@inertialref/shared'
import type { Camera, Object3D, Scene, WebGPURenderer } from 'three/webgpu'
import { BOOT_PHASE } from '../engine/frameTiming.ts'
import { warmTargetFor } from './sensor.ts'

/*
 * The compile-ahead recipe, and the census of what boot is warming.
 *
 * Two layers, and they exist for two different failures.
 *
 * **The recipe** — make visible, `compileAsync` against the live camera and
 * scene, make invisible, swallow the rejection — was written out three times,
 * in `Bodies.tsx`, `WarpFx.tsx` and `TerrainPatches.tsx`, the last of those
 * twice. Each copy made the `WebGPURenderer` cast independently, and each one
 * re-explained the measured fact behind it in prose: the backend builds shader
 * source per material *instance*, so an archetype warmed in `preload.ts` does
 * not cover a real one. A fourth mounted effect that forgot the visibility
 * toggle would compile a variant nothing draws with, silently — and there was
 * nothing to forget it against.
 *
 * **The census** — "what boot must warm" had five producers and no list.
 * `preload.ts` disclaimed the ones it did not cover, and the build-ahead queue
 * in `Bodies.tsx` was invisible to the progress readout, so the status line
 * said "compiling the sky…" while the work measured at 88 ms had not started.
 * The total a producer contributes is declared before it runs, so the bar is
 * the sum of what registered rather than a fraction of what was remembered.
 *
 * Nothing here touches the GPU except through `WarmRenderer`, which is one
 * method — so the whole plan, the order and the totals are assertable in Node
 * against a fake that records what it was asked to compile and whether the
 * object was visible when it was asked.
 */

const log = getLogger('game.warmup')

/*
 * The census is already a list of labeled units of work with a declared total.
 * Timing each one is a `span` around the loop body, and it is the single place
 * that covers every producer in the application — `preload.ts` registers all of
 * its own through here, so instrumenting this instruments those for free and
 * cannot fall out of step with a producer somebody adds next year.
 */
const timer = getTimer('game.warmup')

/* ------------------------------------------------------------------------- */
/* The recipe                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * What warming needs of a renderer: one method.
 *
 * The seam is here rather than at `RendererHandle` because the three scene
 * components have R3F's `gl`, not a handle, and because a handle also carries
 * a tone-curve controller and an output description that warming has no
 * business reading. A `WebGPURenderer` satisfies this structurally, so
 * `preload.ts` passes `handle.renderer` with no cast at all.
 */
export interface WarmRenderer {
  compileAsync(object: Object3D, camera: Camera, scene: Scene): Promise<unknown>
}

export interface WarmTarget {
  readonly object: Object3D
  /** The live camera. A compile against another one is a different pipeline. */
  readonly camera: Camera
  /**
   * The target scene, which carries the lights — and the light set is part of
   * a standard material's generated shader. Compiled against an empty scene,
   * every pipeline here would be a variant nothing ever draws with.
   */
  readonly scene: Scene
}

/**
 * R3F's `gl`, as the one thing warming asks of it.
 *
 * The single cast. R3F types `state.gl` as its own renderer union, which a
 * `WebGPURenderer` is not assignable to and which does not carry
 * `compileAsync`; the three scene components each made this cast for
 * themselves, which is three places for the day the union changes.
 *
 * **The compile is bound to a target of the scene pass's shape.** A pipeline
 * is keyed on the sample count and the formats of what it draws into, and the
 * scene is drawn into the sensor's pass target — four samples, half-float —
 * while the renderer's own framebuffer, which `compileAsync` binds when no
 * target is set, is built at zero. A compile against that builds a variant
 * nothing draws with, and every warmed pipeline is then compiled again on the
 * first presented frame, which is the hitch the census exists to hide.
 *
 * Bound synchronously on both sides of the call. `compileAsync` walks the tree
 * before its first `await` — the same fact `warmCompile`'s visibility toggle
 * stands on — so the target can be put back on the next line, and a frame
 * drawn while the pipelines are still building goes to the canvas.
 */
export const warmRenderer = (gl: object): WarmRenderer => {
  const renderer = gl as WebGPURenderer
  return {
    compileAsync(object, camera, scene) {
      const previous = renderer.getRenderTarget()
      renderer.setRenderTarget(warmTargetFor(renderer))
      const compiled = renderer.compileAsync(object, camera, scene)
      renderer.setRenderTarget(previous)
      return compiled
    },
  }
}

/**
 * Compile one object's pipelines now, so no frame has to.
 *
 * **The visibility toggle is the load-bearing part.** `compileAsync` walks the
 * tree exactly as a render would and skips invisible objects, so a warm-up of
 * something dormant — the warp effects, a body visual built ahead of need —
 * compiles nothing at all unless it is made visible first. Its traversal is
 * *synchronous*, though: the walk that decides what to build runs before the
 * first `await`, so restoring visibility on the very next line happens in the
 * same task and no unit sphere at the origin can reach a drawn frame. The
 * build itself is queued and runs after the call returns, one object at a
 * time with a yield between — the material is read *then*, not now — so two
 * variants of one material are two calls each awaited before the flag flips,
 * never two calls in a row. That is also why this is not an `async` function:
 * the synchronous half has to stay synchronous.
 *
 * The previous visibility is restored rather than set to false, because two of
 * the three callers warm objects that are already on screen.
 *
 * A rejection is swallowed: a pipeline that will not build resurfaces on first
 * draw with a better error than anything worth catching here, and a failed
 * warm-up is a slower first encounter rather than a broken boot.
 */
export function warmCompile(
  renderer: WarmRenderer,
  target: WarmTarget,
): Promise<void> {
  const { object, camera, scene } = target
  const wasVisible = object.visible
  object.visible = true
  const compiled = renderer.compileAsync(object, camera, scene)
  object.visible = wasVisible
  return compiled.then(
    () => undefined,
    () => undefined,
  )
}

/** One macrotask of air, so timers and the watchdog stay serviced. */
export const breathe = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

/* ------------------------------------------------------------------------- */
/* The census                                                                 */
/* ------------------------------------------------------------------------- */

/** What boot is doing, and how far through all of it that is. */
export interface BootProgress {
  /** The verb phrase for the status line, e.g. `baking atmospheres`. */
  readonly label: string
  /** Units finished across every producer, not just the running one. */
  readonly done: number
  /** Units the whole warm-up expects to do. */
  readonly total: number
}

/** One thing boot warms, start to finish, awaited. */
export interface WarmProducer {
  readonly label: string
  /**
   * Units this will report, declared before anything runs.
   *
   * An estimate is fine and is sometimes the only thing available — a texture
   * that fails to decode is one fewer upload than the manifest promised. The
   * shortfall is credited when `run` resolves, so the bar always completes.
   */
  readonly units: number
  /** Do the work, calling `done()` once per unit. */
  run(done: () => void): Promise<void>
}

/**
 * A producer boot counts but does not drive.
 *
 * `Bodies.tsx` builds one body visual per frame — boot cannot await that with
 * a loop, because the frames are what it is waiting *for*. It reports through
 * this instead: the units join the total, the progress joins the bar, and
 * `run` waits for `finish()` or for the deadline, whichever comes first.
 */
export interface WarmTicket {
  /** Declare, or re-declare, how many units this will report. */
  expect(units: number): void
  /** One unit done. */
  done(): void
  /** Nothing more is coming. */
  finish(): void
}

export interface Warmup {
  /**
   * Add a producer. Legal *during* `run`, and that is not an accident: the
   * scene components register from their own mount effects, which R3F
   * schedules independently of the effect that starts the warm-up. The total
   * therefore grows rather than being wrong, and `run` drains the queue until
   * it stops growing.
   *
   * **Idempotent by label**, which is not tidiness — it is what makes this
   * safe to call from a React component. StrictMode double-invokes effects and
   * state initializers, so every registration below happens twice; without
   * this, the second `track('building bodies')` returned a ticket the component
   * never held, boot waited for a producer that could not report, and the cover
   * stayed up at "building bodies 62/62" forever. Two producers with the same
   * label are the same work, so the label is the identity.
   */
  register(producer: WarmProducer): void
  /**
   * Join the census from a frame loop. See `WarmTicket`.
   *
   * Idempotent by label, like `register`.
   */
  track(label: string, units?: number): WarmTicket
  /** Run everything registered. Resolves when the last producer is done. */
  run(onProgress?: (progress: BootProgress) => void): Promise<void>
  /** Whether `run` has already resolved — a late producer missed the boat. */
  readonly settled: boolean
}

/**
 * How long `run` waits for the frame-driven producers after the awaited ones.
 *
 * Generous, because it is the body build-ahead: Sol alone is twenty-nine
 * visuals at one a frame. Bounded, because a cutscene playing at boot pauses
 * that drain and a stalled frame loop must not hold the cover up forever.
 *
 * It counts only while frames could actually be running — see `framesPossible`.
 */
const TRACKED_DEADLINE_MS = 8_000

/**
 * Whether the frame loop can be running at all.
 *
 * The deadline must not count down against a hidden document. Chrome suspends
 * `requestAnimationFrame` entirely for an occluded window, so a page that loads
 * in the background has a frame-driven producer that is not stalled — it has
 * not been given a single frame — and timing it out would abandon the build-
 * ahead for exactly the load that has the most time to spare. Measured: a boot
 * in an occluded automation window burned the whole eight seconds and logged a
 * stall that had not happened.
 *
 * The same rule the presentation watchdog follows, for the same reason.
 */
const framesPossible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

export function createWarmup(
  options: { readonly framesPossible?: () => boolean } = {},
): Warmup {
  const canRunFrames = options.framesPossible ?? framesPossible
  const queue: WarmProducer[] = []
  const tickets: {
    label: string
    units: number
    done: number
    finished: boolean
  }[] = []
  /** One handle per label, so a repeated `track` is the same ticket. */
  const handles = new Map<string, WarmTicket>()
  let done = 0
  let settled = false
  let notify: ((progress: BootProgress) => void) | null = null
  let label = ''

  /** Declared units of everything, awaited and tracked alike. */
  const total = (): number =>
    queue.reduce((n, producer) => n + producer.units, 0) +
    tickets.reduce((n, ticket) => n + ticket.units, 0)

  const publish = (): void => {
    notify?.({
      label,
      done: done + tickets.reduce((n, ticket) => n + ticket.done, 0),
      total: Math.max(1, total()),
    })
  }

  return {
    get settled() {
      return settled
    },

    register(producer) {
      if (queue.some((one) => one.label === producer.label)) return
      queue.push(producer)
      publish()
    },

    track(label: string, units = 0) {
      const existing = handles.get(label)
      if (existing !== undefined) return existing
      const ticket = { label, units, done: 0, finished: false }
      tickets.push(ticket)
      publish()
      const handle: WarmTicket = {
        expect(next) {
          ticket.units = next
          publish()
        },
        done() {
          ticket.done += 1
          publish()
        },
        finish() {
          ticket.finished = true
          // Credit the shortfall, so a queue that turned out shorter than
          // declared does not leave the bar stuck a few units short.
          ticket.done = ticket.units
          publish()
        },
      }
      handles.set(label, handle)
      return handle
    },

    async run(onProgress) {
      notify = onProgress ?? null
      const started = performance.now()
      /*
       * Index rather than `shift`, so a producer registered while this runs is
       * picked up on the next turn of the loop instead of being lost to a
       * queue that was already drained.
       */
      for (let i = 0; i < queue.length; i += 1) {
        const producer = queue[i] as WarmProducer
        label = producer.label
        const before = done
        publish()
        // The producer's own label, which is prose written for the boot status
        // line — "warming surface maps", "compiling the sky". It is also the
        // right label on a track: the entry and the line a viewer read while it
        // was happening say the same thing.
        const span = timer.span(producer.label, BOOT_PHASE)
        try {
          await producer.run(() => {
            done += 1
            publish()
          })
        } catch (cause) {
          // One producer failing is a slower first encounter with whatever it
          // covered, not a boot that never lifts its cover.
          log.warn('a warm-up producer failed', {
            producer: producer.label,
            cause: String(cause),
          })
        }
        // Outside the catch as well as the try: a producer that threw still
        // spent the time, and an entry that appeared only on success would make
        // a failing warm-up look instantaneous — which is the opposite of what
        // it is. `Span.end` is idempotent, so this is safe on both paths.
        span.end()
        // Credit whatever it did not report, so the bar cannot stall below its
        // own total on a producer that overcounted or gave up early.
        done = Math.max(done, before + producer.units)
        publish()
      }

      await waitForTickets()
      settled = true
      notify = null
      const finished = performance.now()
      // The whole warm-up as one entry, over the per-producer ones — from the
      // two numbers the log line already had. The tracked producers are inside
      // it and the frame-driven ones are the tail, which is the shape that
      // shows a build-ahead still draining after everything awaited is done.
      if (timer.on) timer.measure('warm-up', started, finished, BOOT_PHASE)
      log.info('warm-up complete', {
        ms: Math.round(finished - started),
        producers: queue.length,
        tracked: tickets.length,
        units: total(),
      })
    },
  }

  async function waitForTickets(): Promise<void> {
    if (tickets.length === 0) return
    let deadline = performance.now() + TRACKED_DEADLINE_MS
    label = tickets.find((one) => !one.finished)?.label ?? label
    while (tickets.some((one) => !one.finished)) {
      // Push the deadline ahead of a document that cannot draw. Not a pause on
      // the loop: the cover is over a canvas nobody is looking at either way,
      // and the moment the window comes back the drain resumes with its full
      // allowance rather than a spent one.
      if (!canRunFrames()) deadline = performance.now() + TRACKED_DEADLINE_MS
      if (performance.now() > deadline) {
        log.warn('frame-driven warm-up did not finish in time', {
          waiting: tickets
            .filter((one) => !one.finished)
            .map((one) => one.label),
        })
        for (const ticket of tickets) ticket.finished = true
        break
      }
      label = tickets.find((one) => !one.finished)?.label ?? label
      publish()
      await breathe()
    }
  }
}

/* ------------------------------------------------------------------------- */
/* The session's warm-up                                                      */
/* ------------------------------------------------------------------------- */

/*
 * Module state, for the same reason `preload.ts` holds its warm group there.
 *
 * The producers are `preload.ts` and three components with no common ancestor
 * to thread a parameter through — R3F renders the scene into its own root, so
 * `App` cannot hand anything down to `Bodies` that is not a prop on the scene
 * tree, and a registry is not scene data. `createWarmup` is exported and takes
 * nothing, so every test drives its own instance and none of them touch this.
 */
let session: Warmup | null = null

/** Start a fresh census. One per renderer build; a rebuild re-warms. */
export function beginWarmup(): Warmup {
  session = createWarmup()
  return session
}

/**
 * Warm something from a component's mount effect.
 *
 * Registers with the session's warm-up while boot is still running, so the
 * cover stays up until this pipeline exists — which is the whole reason these
 * compiles are at mount rather than on first draw. Once boot has settled it
 * simply does the work: a component can mount mid-session, and the renderer is
 * rebuilt outright when the HDR preference changes.
 */
export function warmAtMount(producer: WarmProducer): void {
  if (session !== null && !session.settled) {
    session.register(producer)
    return
  }
  void producer
    .run(() => {})
    .catch((cause: unknown) => {
      log.warn('a late warm-up failed', {
        producer: producer.label,
        cause: String(cause),
      })
    })
}

/** The no-op every ticket verb becomes once there is no boot to report to. */
const IDLE_TICKET: WarmTicket = {
  expect: () => {},
  done: () => {},
  finish: () => {},
}

/**
 * Join the session's census from a frame loop.
 *
 * Returns a ticket that does nothing when boot has already lifted, so the
 * caller's frame loop needs no branch — the mid-session trickle after a jump
 * is the same code as the boot drain, reporting into nothing.
 */
export function trackAtMount(label: string, units = 0): WarmTicket {
  if (session === null || session.settled) return IDLE_TICKET
  return session.track(label, units)
}
