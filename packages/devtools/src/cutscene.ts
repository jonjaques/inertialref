import { getLogger } from '@inertialref/shared'
import { type FrameState, UV, type Vec3 } from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import type { EntityId } from '@inertialref/universe'
import { type CinematicSample, isUsableLens } from '@inertialref/rendering'
import type { Host } from './harness.ts'

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
  /**
   * The name of the track the scene is cut to, under the site's `/media/`,
   * without its extension — the overlay asks for it in whichever encoding
   * the browser decodes. Absent for a scene with no music, which plays
   * silent.
   *
   * Sound is staging, so the script declares it, the same way a script turns
   * an effect on. A track chosen by the overlay is a track for every scene:
   * the title sequence's music played over the Mars landing, from the first
   * frame of the entry burn, because the overlay owned one track and started
   * it for whatever was open.
   */
  readonly soundtrack?: string
  prepare(world: World): PreparedCutscene
}

/** How `play` is asked to run a scene. */
export interface PlayOptions {
  /**
   * Keep the last frame on stage rather than restoring the player on it.
   *
   * On the final frame the director parks the playhead there, pauses the
   * clock and reports the scene `ended` while `status()` stays live and
   * `sample` keeps answering with that frame; `stop` restores as it always
   * does. Off, the final frame restores the player and returns null, which
   * is what a driver's `ir.play` and every measurement want. A seek away
   * from a held end clears the outcome; the clock stays paused until a
   * `resume`, as after any pause.
   */
  readonly hold?: boolean
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
  /** Whether the last frame is held on stage. See `PlayOptions`. */
  readonly hold: boolean
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
  readonly #host: Host
  readonly #scripts: readonly CutsceneScript[]
  #active: ActiveCutscene | null = null
  #last: CutsceneOutcome | null = null

  constructor(host: Host, scripts: readonly CutsceneScript[]) {
    this.#host = host
    this.#scripts = scripts
  }

  list(): readonly {
    id: string
    description: string
    seconds: number
    soundtrack: string | null
  }[] {
    return this.#scripts.map((script) => ({
      id: script.id,
      description: script.description,
      seconds: script.durationFrames / script.fps,
      soundtrack: script.soundtrack ?? null,
    }))
  }

  /**
   * How the last scene left, or `null` if none ever has — or, for a scene
   * held on its last frame, that it ended while it is still on stage.
   *
   * `status()` answers "is a scene playing" and goes null for three different
   * reasons; this is what tells them apart. Without it a caller has to
   * reconstruct the answer from a null and a remembered playhead — the cinema
   * player did, with a half-second window around the final frame, and
   * `stopCutscene` from the console read as an ending because it produced the
   * identical evidence.
   *
   * Cleared by `play`, so it always describes the *last* scene rather than an
   * older one, and by a seek away from a held end.
   */
  lastOutcome(): CutsceneOutcome | null {
    return this.#last
  }

  status(): CutsceneStatus | null {
    const active = this.#active
    if (active === null) return null
    // A held end reports the last frame as a fact rather than as arithmetic:
    // recomputed from the epoch it lands a fraction short, and the session's
    // play-at-the-end test is an exact comparison. See `#heldAtEnd`.
    const frame = this.#heldAtEnd(active)
      ? active.script.durationFrames - 1
      : active.epoch === null || active.lastRenderTime === null
        ? (active.pendingSeekFrame ?? 0)
        : (active.lastRenderTime - active.epoch) * active.script.fps
    return {
      id: active.script.id,
      frame,
      durationFrames: active.script.durationFrames,
      fps: active.script.fps,
    }
  }

  play(id: string, options: PlayOptions = {}): CutsceneStatus {
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
      hold: options.hold ?? false,
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
     * `surfaceStance.ts` declines a height it cannot stand at.
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
    /*
     * A held end is over once the playhead leaves it: the outcome is cleared
     * because the next ending is a new one. Nothing else changes — the clock
     * stays as it was, paused if the hold parked it, and `resume` is what
     * runs it, as after any pause. Only a held scene can be active with an
     * outcome at all.
     *
     * A seek *onto* the last frame is not a seek away — the player's "Stay
     * on the last frame" is one — and it keeps the hold. Cleared, the
     * playhead is arithmetic again, `(t − (t − last/fps)) × fps`, which
     * reads short of the last frame at 14.3% of renderTimes; see
     * `#heldAtEnd` for what an inexact last frame costs the Play button.
     */
    const stays = active.hold && clamped === active.script.durationFrames - 1
    if (!stays && this.#last?.ending === 'ended') this.#last = null
    return this.status() as CutsceneStatus
  }

  /**
   * The frame's cinematic state, or null when nothing is playing.
   *
   * Called by the host once per rendered frame with the snapshot's
   * `renderTime`. The first call anchors frame 0; the final frame restores the
   * player and returns null, so a host needs no separate end-of-scene check —
   * unless the scene was played with `hold`, in which case it stays.
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
    if (frame >= active.script.durationFrames || this.#heldAtEnd(active)) {
      if (active.hold) return this.#holdLastFrame(active, renderTime)
      // `ended`, not `stopped`. It is the same restore either way, and it is a
      // completely different thing to a player: one draws an end card, the
      // other closes the transport.
      this.#finish('ended')
      return null
    }
    return active.prepared.sample(Math.max(0, frame))
  }

  /**
   * Whether the scene is parked on its last frame.
   *
   * A state, not a comparison of the playhead against the end. The playhead
   * is arithmetic on `renderTime`, and parking pauses the clock, whose alpha
   * is then 0: the next frame's `renderTime` is *lower* than the parking
   * one by whatever the accumulator held, up to a tick, and even at a drop
   * of zero `(t - epoch) * fps` rounds a fraction short of the last frame.
   * Both read as "before the end", so the hold branch would not be taken and
   * `status()` would publish a frame the session's exact play-at-the-end
   * comparison rejects — Play resumed the clock, the scene walked off the
   * end and re-parked a sample later with the outcome already written, and
   * the card never came back. Only `#holdLastFrame` writes an `ended`
   * outcome while a scene is active; `seek` and `play` clear it.
   */
  #heldAtEnd(active: ActiveCutscene): boolean {
    return active.hold && this.#last?.ending === 'ended'
  }

  /**
   * Park on the last frame and stay there.
   *
   * The epoch is re-based so the playhead reads exactly the last frame on
   * the frame that parks, and the clock is paused so it stays put; every
   * later sample takes this branch on `#heldAtEnd` rather than on the
   * playhead. A resume walks off the end on the next sample and lands back
   * here, which is why the session's play at the end is a seek to the top.
   * The outcome is written once, not per frame: this runs on every sample
   * while the picture is held, and the clock being paused does not stop the
   * host sampling.
   */
  #holdLastFrame(active: ActiveCutscene, renderTime: number): CinematicSample {
    const last = active.script.durationFrames - 1
    active.epoch = renderTime - last / active.script.fps
    active.world.clock.setPaused(true)
    if (this.#last === null) {
      this.#last = {
        id: active.script.id,
        ending: 'ended',
        durationFrames: active.script.durationFrames,
        fps: active.script.fps,
      }
      log.info('cutscene ended, holding its last frame', {
        id: active.script.id,
      })
    }
    return active.prepared.sample(last)
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

/** Guard against a script emitting a non-finite pose or lens; used by tests. */
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
    finiteQuat(sample.ship.orientation) &&
    (sample.presentationTime === undefined ||
      Number.isFinite(sample.presentationTime)) &&
    (sample.elapsedSeconds === undefined ||
      Number.isFinite(sample.elapsedSeconds)) &&
    (sample.stage === undefined ||
      (UV.isValid(sample.stage.position) &&
        finiteQuat(sample.stage.orientation))) &&
    // The lens too, and it is the field with the shortest path to a black
    // frame: `CameraRig` writes `verticalFovDegrees(engine.lens)` straight into
    // `camera.fov`, so one non-finite focal length in a script is a NaN
    // projection matrix and nothing drawn anywhere. `lensForFov` clamps the
    // slider's route in; a `CutsceneScript.sample()` builds its lens by hand
    // and has no clamp between it and the camera.
    isUsableLens(sample.lens) &&
    // Every drive is optional and, when present, on the closed unit interval.
    [
      sample.ship.throttle,
      sample.effects.entryHeat,
      sample.effects.landingDust,
      sample.effects.skyHaze,
      sample.effects.lensArtifacts,
      sample.effects.anamorphicFlare,
    ].every(unitDrive)
  )
}

const unitDrive = (drive: number | undefined): boolean =>
  drive === undefined || (Number.isFinite(drive) && drive >= 0 && drive <= 1)
