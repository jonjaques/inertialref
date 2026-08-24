import { getLogger } from '@inertialref/shared'
import { type FrameState, UV, type Vec3 } from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import type { EntityId } from '@inertialref/universe'
import type { CinematicSample } from '@inertialref/rendering'
import type { HarnessHost } from './harness.ts'

/*
 * The cutscene director: scripted scenes over a running world.
 *
 * A cutscene here is presentation, not gameplay: it borrows the camera and the
 * hero hull, runs a scripted timeline against the simulation's own clock, and
 * hands everything back exactly as it found it. Nothing canonical is decided
 * by a script — the world keeps ticking underneath, and stopping a cutscene
 * restores the player's captured state through the same verbs a save-load
 * uses. That is what keeps this on the right side of the design charter's
 * "no cutscene hides a level swap": there is no swap to hide. ADR-0010 holds
 * the longer argument.
 *
 * Time comes from the snapshot's `renderTime`, not from a wall clock, so a
 * script is deterministic, replayable under `ir.step`, and seekable to an
 * exact reference frame — which is what lets a render be measured against the
 * reference edit numerically rather than eyeballed.
 */

const log = getLogger('devtools.cutscene')

/**
 * A scripted scene. `prepare` resolves everything the script needs from the
 * live world — body positions, radii, the stage anchor — once, at play time;
 * `sample` is then a pure function of the (fractional) frame number. The split
 * matters: sampling runs every rendered frame and must not touch the world,
 * or a paused cutscene would still be asking the universe questions.
 */
export interface CutsceneScript {
  readonly id: string
  /** One line for the dock and `ir.cutscenes()`. */
  readonly description: string
  /** Frames per second of the reference edit this script is timed against. */
  readonly fps: number
  readonly durationFrames: number
  prepare(world: World): PreparedCutscene
}

export interface PreparedCutscene {
  sample(frame: number): CinematicSample
}

export interface CutsceneStatus {
  readonly id: string
  readonly frame: number
  readonly durationFrames: number
  readonly fps: number
}

/** What `play` captures and `stop` restores. */
interface SavedPlayerState {
  readonly state: FrameState
  readonly flightAssist: boolean
  readonly control: { translation: Vec3; rotation: Vec3 }
  readonly timeScale: number
  readonly paused: boolean
}

interface ActiveCutscene {
  readonly script: CutsceneScript
  readonly prepared: PreparedCutscene
  /** The world this cutscene was prepared against — see `sample`. */
  readonly world: World
  readonly player: EntityId
  readonly saved: SavedPlayerState
  /** Sim `renderTime` at frame 0. Null until the first sample lands. */
  epoch: number | null
  /** A seek issued before the next sample; applied when it arrives. */
  pendingSeekFrame: number | null
  lastRenderTime: number | null
}

/**
 * How a scene left the director.
 *
 * `ended` ran to its final frame; `stopped` was stopped by somebody; and
 * `abandoned` lost the world it was playing in — a save loaded from the
 * console, say.
 */
export type CutsceneEnding = 'ended' | 'stopped' | 'abandoned'

/** Which scene left, and how. */
export interface CutsceneOutcome {
  readonly id: string
  readonly ending: CutsceneEnding
  readonly durationFrames: number
  readonly fps: number
}

export class CutsceneDirector {
  readonly #host: HarnessHost
  readonly #scripts: readonly CutsceneScript[]
  #active: ActiveCutscene | null = null
  #last: CutsceneOutcome | null = null

  constructor(host: HarnessHost, scripts: readonly CutsceneScript[]) {
    this.#host = host
    this.#scripts = scripts
  }

  list(): readonly { id: string; description: string; seconds: number }[] {
    return this.#scripts.map((script) => ({
      id: script.id,
      description: script.description,
      seconds: script.durationFrames / script.fps,
    }))
  }

  /**
   * How the last scene left, or `null` if none ever has.
   *
   * `status()` answers "is a scene playing" and goes null for three different
   * reasons; this is what tells them apart. Without it a caller has to
   * reconstruct the answer from a null and a remembered playhead — the cinema
   * player did, with a half-second window around the final frame, and
   * `stopCutscene` from the console read as an ending because it produced the
   * identical evidence.
   *
   * Cleared by `play`, so it always describes the *last* scene rather than an
   * older one.
   */
  lastOutcome(): CutsceneOutcome | null {
    return this.#last
  }

  status(): CutsceneStatus | null {
    const active = this.#active
    if (active === null) return null
    const frame =
      active.epoch === null || active.lastRenderTime === null
        ? (active.pendingSeekFrame ?? 0)
        : (active.lastRenderTime - active.epoch) * active.script.fps
    return {
      id: active.script.id,
      frame,
      durationFrames: active.script.durationFrames,
      fps: active.script.fps,
    }
  }

  play(id: string): CutsceneStatus {
    const script = this.#scripts.find((candidate) => candidate.id === id)
    if (script === undefined) {
      throw new Error(
        `Unknown cutscene "${id}". Try: ${this.#scripts.map((s) => s.id).join(', ')}`,
      )
    }
    // Replaying while one runs restores first, so state capture never nests —
    // a second capture would remember the *cutscene's* clock settings.
    if (this.#active !== null) this.stop()

    const world = this.#host.world
    const player = this.#host.player()
    if (player === null) throw new Error('No player entity to give back after')
    const entity = world.entities.require(player)

    const saved: SavedPlayerState = {
      state: {
        frame: entity.state.frame,
        position: { ...entity.state.position },
        velocity: { ...entity.state.velocity },
        orientation: { ...entity.state.orientation },
        angularVelocity: { ...entity.state.angularVelocity },
      },
      flightAssist: entity.flightAssist,
      control: {
        translation: { ...entity.control.translation },
        rotation: { ...entity.control.rotation },
      },
      timeScale: world.clock.timeScale,
      paused: world.clock.paused,
    }

    const prepared = script.prepare(world)

    // The reference edit is timed in real seconds, so the clock must run at
    // 1× and run at all; both are restored on stop.
    world.clock.setTimeScale(1)
    world.clock.setPaused(false)

    this.#active = {
      script,
      prepared,
      world,
      player,
      saved,
      epoch: null,
      pendingSeekFrame: null,
      lastRenderTime: null,
    }
    // A scene that is playing has not left yet.
    this.#last = null
    log.info('cutscene started', { id, frames: script.durationFrames })
    return this.status() as CutsceneStatus
  }

  /** Stop and restore. Safe to call when nothing is playing. */
  stop(): void {
    this.#finish('stopped')
  }

  #finish(ending: CutsceneEnding): void {
    const active = this.#active
    if (active === null) return
    this.#active = null
    this.#last = {
      id: active.script.id,
      ending,
      durationFrames: active.script.durationFrames,
      fps: active.script.fps,
    }

    // The world can be replaced under a running cutscene (a save loaded from
    // the console). The captured state belongs to the discarded world;
    // restoring it into the new one would teleport a stranger.
    if (active.world !== this.#host.world) {
      this.#last = { ...this.#last, ending: 'abandoned' }
      log.warn('cutscene abandoned: the world it was playing in is gone', {
        id: active.script.id,
      })
      return
    }

    const world = active.world
    const { saved, player } = active
    world.teleport(player, saved.state)
    world.setControl(player, saved.control.translation, saved.control.rotation)
    world.setFlightAssist(player, saved.flightAssist)
    world.clock.setTimeScale(saved.timeScale)
    world.clock.setPaused(saved.paused)
    log.info('cutscene stopped, player state restored', {
      id: active.script.id,
    })
  }

  /**
   * Jump the playhead to a reference frame. With the clock paused this gives
   * frame-exact stills — the capture loop the verification pipeline needs.
   */
  seek(frame: number): CutsceneStatus {
    const active = this.#active
    if (active === null) throw new Error('No cutscene is playing')
    /*
     * Non-finite input is declined rather than clamped, the way
     * `Observatory.setFov` declines a field of view it cannot use.
     * `Math.max(0, Math.min(NaN, n))` is `NaN`, which lands in `epoch` — and
     * `epoch` is never recomputed, so every subsequent frame is `NaN`, the
     * `frame >= durationFrames` end test is false forever, and the scene
     * renders black with no way out but a reload. A seek comes from a range
     * input, a URL parameter and a console line; all three can produce one.
     */
    if (!Number.isFinite(frame)) {
      log.warn('ignoring a seek to a frame that is not a number', {
        id: active.script.id,
      })
      return this.status() as CutsceneStatus
    }
    const clamped = Math.max(
      0,
      Math.min(frame, active.script.durationFrames - 1),
    )
    if (active.lastRenderTime === null) {
      active.pendingSeekFrame = clamped
    } else {
      active.epoch = active.lastRenderTime - clamped / active.script.fps
    }
    return this.status() as CutsceneStatus
  }

  /**
   * The frame's cinematic state, or null when nothing is playing.
   *
   * Called by the host once per rendered frame with the snapshot's
   * `renderTime`. The first call anchors frame 0; the final frame restores the
   * player and returns null, so a host needs no separate end-of-scene check.
   */
  sample(renderTime: number): CinematicSample | null {
    const active = this.#active
    if (active === null) return null
    if (active.world !== this.#host.world) {
      // Abandon without restore — see `stop` for why restoring would be worse.
      this.#active = null
      this.#last = {
        id: active.script.id,
        ending: 'abandoned',
        durationFrames: active.script.durationFrames,
        fps: active.script.fps,
      }
      return null
    }

    active.lastRenderTime = renderTime
    if (active.epoch === null) {
      const start = active.pendingSeekFrame ?? 0
      active.epoch = renderTime - start / active.script.fps
      active.pendingSeekFrame = null
    }

    const frame = (renderTime - active.epoch) * active.script.fps
    if (frame >= active.script.durationFrames) {
      // `ended`, not `stopped`. It is the same restore either way, and it is a
      // completely different thing to a player: one draws an end card, the
      // other closes the transport.
      this.#finish('ended')
      return null
    }
    return active.prepared.sample(Math.max(0, frame))
  }

  /**
   * Sample a frame without moving the playhead.
   *
   * `sample` is the host's per-frame ask and it *owns* the playhead: it anchors
   * the epoch on its first call and records `lastRenderTime`, which is the
   * instant `seek` re-bases against. So a second caller wanting a *different*
   * frame cannot go through it — the picture would chase whatever the last
   * asker wanted. The track overlay is that second caller: it takes a central
   * difference of the hull's camera-relative offset half a frame either side of
   * the one on screen, which is a velocity that stays correct while paused and
   * while seeking, where differencing consecutive rendered frames gives zero
   * and then a spike.
   *
   * The script's `sample` is pure by contract (see `PreparedCutscene`), so this
   * is only as expensive as the arithmetic and touches no state at all.
   *
   * Frames outside the scene are clamped rather than declined: a central
   * difference at frame 0 legitimately asks for −0.5.
   */
  peek(frame: number): CinematicSample | null {
    const active = this.#active
    if (active === null || !Number.isFinite(frame)) return null
    // The same gate `sample` opens with, and for the same reason: a prepared
    // stage is resolved against one world, so once the host has replaced it
    // every pose here is from a scene that no longer exists. `sample` abandons
    // on this; a reader must not answer from it in the frames before that
    // happens.
    if (active.world !== this.#host.world) return null
    const last = active.script.durationFrames - 1
    return active.prepared.sample(Math.max(0, Math.min(frame, last)))
  }
}

/** Guard against a script emitting a non-finite pose; used by tests. */
export function sampleIsFinite(sample: CinematicSample): boolean {
  const finiteQuat = (q: { x: number; y: number; z: number; w: number }) =>
    Number.isFinite(q.x) &&
    Number.isFinite(q.y) &&
    Number.isFinite(q.z) &&
    Number.isFinite(q.w)
  return (
    UV.isValid(sample.camera.position) &&
    finiteQuat(sample.camera.orientation) &&
    UV.isValid(sample.ship.position) &&
    finiteQuat(sample.ship.orientation)
  )
}
