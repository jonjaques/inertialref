'use no memo'
import { useEffect, useRef, useState } from 'react'
import { mediaPath } from '@inertialref/protocol'
import { getLogger } from '@inertialref/shared'
import type { CinematicTextState, GameEngine } from '../engine/GameEngine.ts'
import { CutsceneTransport } from './CutsceneTransport.tsx'
import { labelStyle, textStyle } from './cutsceneText.ts'
import { useAction, useKeyContext } from '../input/useKeymap.ts'
import { useScrubber } from './useScrubber.ts'
import { useEngine } from '../state/engineStore.ts'

/*
 * The cutscene's screen-space layer: the blackout, the title cards, the
 * optional synced audio and the skip key.
 *
 * DOM rather than canvas because the reference's text behavior is exactly
 * what DOM is good at — absolutely positioned lines, opacity fades, real
 * typefaces — and because the analysis pipeline measures titles by color
 * masking a video capture, which cares nothing for how the pixels were made.
 *
 * `'use no memo'`: the render body reads `engine.cutsceneAudio`, a plain field
 * the console may write — the PerfPanel case exactly. The transport's readout
 * no longer needs it: that is a published playhead now, and its selector bails
 * out honestly. React renders only the *structure* (once per cutscene
 * start/stop); the per-frame opacity and transform writes go straight to the
 * DOM nodes from a rAF loop, because 24-fps-timed fades re-rendered through
 * React at display rate would be all reconcile and no picture.
 */

const log = getLogger('game.cutscene')

/** How closely the audio element tracks the reference clock, seconds. */
const AUDIO_TOLERANCE = 0.08

/**
 * Where the reference track is served from, in the order it is preferred.
 *
 * `/media/` is the site's object storage, not the bundle: the file is
 * copyrighted music that never enters the repository, so the build pulls it out
 * of R2 and the Worker falls back to the same bucket when a build could not.
 * `apps/server/src/media.ts` is the arrangement — including why one track has
 * two encodings and why AAC comes first — and the paths are spelled by
 * `mediaPath` so this file, the router and `run_worker_first` cannot drift.
 *
 * The `codecs` parameter is not decoration. `canPlayType('audio/mp4')` alone
 * answers `maybe` on a browser that has the container and not the profile, and
 * `maybe` is indistinguishable from `probably` here — both are non-empty, and
 * both would have this adopt a file it cannot decode and then play the scene
 * silent with no error to read. Naming `mp4a.40.2` asks the question that has
 * an answer.
 */
const CUTSCENE_AUDIO = [
  { src: mediaPath('tng-intro.m4a'), type: 'audio/mp4; codecs="mp4a.40.2"' },
  { src: mediaPath('tng-intro.mp3'), type: 'audio/mpeg' },
] as const

/**
 * The events that carry a user activation, on every engine that has one.
 *
 * Broader than it looks like it needs to be, and deliberately: the spec's list
 * of activation-triggering events and WebKit's are not the same list, and this
 * is the one place where guessing wrong costs the whole feature rather than a
 * frame. `pointerdown` covers mouse and touch where Pointer Events are the
 * primary input path; `touchend` and `mousedown` cover the engines that set
 * their gesture flag on the legacy event instead. All of them are harmless
 * duplicates — the primer is idempotent.
 */
const GESTURES = [
  'pointerdown',
  'mousedown',
  'touchend',
  'keydown',
  'click',
] as const

export function CutsceneOverlay({
  engine,
  transport: showTransport = false,
}: {
  engine: GameEngine
  /**
   * Whether to draw the scrubber and the pause button.
   *
   * Off by default, because there are now two things that can put a transport
   * on screen — this and the cinema player — and two playheads a person can
   * disagree with is worse than none. `apps/game/src/App.tsx` turns it on with
   * the debug overlay, which is where a scrub-while-flying belongs; the cinema
   * mode has its own, with a timecode and a shareable link.
   */
  transport?: boolean
}) {
  // Structure state only: which cutscene's text set is mounted. Polled slowly
  // — starting and stopping are human-rate events.
  const [texts, setTexts] = useState<readonly CinematicTextState[] | null>(null)
  /*
   * The transport's readout: the same published playhead the cinema player
   * reads, so the two cannot disagree and neither costs a timer. This file used
   * to poll the director every 100 ms and read `world.clock.paused` for itself.
   */
  const transport = useEngine((snapshot) => snapshot.playhead)
  // The pointer latch and the guarded seek, shared with the cinema player's
  // transport — see `useScrubber.ts` for what each of them is for.
  const { grab, seek } = useScrubber(engine)
  const blackout = useRef<HTMLDivElement>(null)
  const hint = useRef<HTMLDivElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const lines = useRef(new Map<string, HTMLDivElement>())
  /*
   * The adopted track, mirrored into state.
   *
   * `engine.cutsceneAudio` is a plain field and writing one schedules nothing,
   * so on the field alone the element mounted whenever something *else*
   * re-rendered this component — which, before a scene is open, is never. The
   * element has to exist before the first gesture (see the primer below), so
   * the probe's answer has to be able to cause a render. The field is still
   * read first, so a console write retargets the element as it always did.
   */
  const [adopted, setAdopted] = useState<string | null>(null)
  /** Whether a refused `play()` has already been reported. See the rAF loop. */
  const refused = useRef(false)

  /*
   * The text list, which is structure rather than a readout.
   *
   * Keyed off the *published* playhead rather than a timer: `engine.cinematic`
   * is rebuilt every frame, and the array inside it is static for the life of a
   * script — so adopting the array itself as the mounted structure makes "same
   * cutscene" a reference check, and this effect only has to run when a scene
   * opens or closes.
   */
  const sceneId = transport?.id ?? null
  useEffect(() => {
    if (sceneId === null) {
      setTexts(null)
      return
    }
    setTexts((current) => current ?? engine.cinematic?.texts ?? null)
  }, [engine, sceneId, transport])

  /*
   * A running scene is a context, and Escape skips it.
   *
   * The claim is live only while a scene is actually playing, which is the
   * `engine.cinematic !== null` the listener used to check on every keystroke:
   * as a context it is checked once, when the scene starts and stops, and the
   * dispatcher never has to be told about a mode that is not running.
   */
  useKeyContext({ context: 'cutscene' }, transport !== null)
  useAction('cutscene.skip', () => {
    if (engine.cinematic !== null) engine.harness.stopCutscene()
  })

  /*
   * Adopt the reference audio when this deployment has it, in a format this
   * browser can decode.
   *
   * The track is copyrighted music and never enters the repository — the path
   * is gitignored, and `scripts/media.mjs` pulls it out of the site's R2 bucket
   * at build time — so a fork, a checkout without credentials and a local build
   * before the first pull all legitimately have no file there. Hence a probe
   * rather than an assumption: the cutscene plays silent when it is absent,
   * which is a scene without music rather than a broken one.
   *
   * Two questions per candidate, and both have to be asked. `canPlayType` is
   * free and local; the HEAD is neither, so it runs only for a format that
   * would be used. A deployment may carry one encoding, both, or neither.
   *
   * `engine.cutsceneAudio` stays writable from the console for a differently
   * named local file, and takes precedence over whatever this adopted.
   */
  useEffect(() => {
    if (engine.cutsceneAudio !== null) return
    let cancelled = false
    const decoder = document.createElement('audio')
    void (async () => {
      for (const candidate of CUTSCENE_AUDIO) {
        if (decoder.canPlayType(candidate.type) === '') continue
        const response = await fetch(candidate.src, { method: 'HEAD' }).catch(
          () => null,
        )
        if (cancelled) return
        /*
         * `ok` is not enough, and the reason is the same one the Worker's own
         * media handler carries: a single-page fallback answers a path it does
         * not have with the document and a **200**. In production the Worker
         * now 404s an unlisted name, but Vite's dev server does not — so
         * without the content-type check, a developer who has never run
         * `pnpm media:pull` hands an `<audio>` element `index.html` and gets a
         * decode error instead of a silent cutscene.
         */
        const type = response?.headers.get('content-type') ?? ''
        if (response?.ok !== true || !type.startsWith('audio/')) continue
        engine.cutsceneAudio = candidate.src
        setAdopted(candidate.src)
        return
      }
      log.info('no reference track is served here; the scene plays silent')
    })()
    return () => {
      cancelled = true
    }
  }, [engine])

  /*
   * Prime the element on the first user gesture, whatever that gesture is for.
   *
   * A scene's audio is started from a rAF loop, which is the only place that
   * knows where the playhead is — and on Safari a `play()` outside the task a
   * user activation arrived in is refused, so the scene played silent on every
   * iPhone with nothing but a swallowed rejection to say so. Chrome's sticky
   * activation carries far enough that the same code works there, which is
   * exactly why the defect is invisible on a desktop.
   *
   * So the unlock is separated from the playback: one `play()` inside a real
   * gesture, and the element is permitted for the rest of the page's life. It
   * is inaudible — the reference track opens on two seconds of digital silence
   * and this lasts a frame — and it is why the element is mounted as soon as a
   * track is adopted rather than when a scene starts. The gesture that starts
   * the scene is the click on the library card, and an element that mounts in
   * response to that click has already missed it.
   *
   * The listeners come off on the first `play()` that resolves, and not before:
   * a refusal has to be able to try the next gesture. Capture phase, so a
   * handler that stops propagation cannot take the activation with it.
   *
   * What this cannot fix is the iOS ring/silent switch, which mutes an
   * `<audio>` element by policy and is not a thing a page is allowed to ask
   * about.
   */
  useEffect(() => {
    let unlocked = false
    const remove = (): void => {
      for (const type of GESTURES)
        document.removeEventListener(type, prime, true)
    }
    const prime = (): void => {
      const element = audio.current
      if (unlocked || element === null) return
      void element.play().then(
        () => {
          unlocked = true
          remove()
          // Unlocking, not starting: the rAF loop below owns whether the track
          // sounds and where it is. Left running only if a scene is already
          // playing, which is the case where this gesture was the Play button.
          if (engine.cinematic === null || engine.world.clock.paused) {
            element.pause()
            element.currentTime = 0
          }
          // A refusal is not news here — it is the ordinary answer for a gesture
          // that reached this before the file finished loading. The listeners
          // stay on, and the next gesture tries again.
        },
        () => {},
      )
    }
    for (const type of GESTURES) document.addEventListener(type, prime, true)
    return remove
  }, [engine])

  // The per-frame writes. A rAF loop of its own rather than `useFrame`
  // because this component lives outside the canvas.
  useEffect(() => {
    let handle = 0
    const tick = (): void => {
      handle = window.requestAnimationFrame(tick)
      const view = engine.cinematic
      if (blackout.current !== null) {
        blackout.current.style.opacity =
          view === null ? '0' : String(view.effects.blackout)
      }
      if (hint.current !== null) {
        hint.current.style.opacity = view === null ? '0' : '1'
        if (view !== null) {
          hint.current.textContent = `f${Math.floor(view.frame)} · esc skips`
        }
      }
      for (const [id, node] of lines.current) {
        const state = view?.texts.find((text) => text.id === id)
        if (state === undefined) {
          node.style.opacity = '0'
          continue
        }
        node.style.opacity = String(state.opacity)
        // Position every frame, not just opacity: the logotype's two words are
        // thrown in from opposite sides of the frame and shrink onto their
        // marks. Writing `left`/`top` alongside the transform keeps the scale
        // centered on the line while the line itself travels.
        node.style.left = `${state.x * 100}%`
        node.style.top = `${state.y * 100}%`
        node.style.transform = `translate(-50%, -50%) scale(${state.scale})`
      }

      // Audio: chase the reference clock, correct only outside lip-sync
      // tolerance — seeking every frame stutters the element.
      const element = audio.current
      if (element !== null) {
        if (view === null) {
          if (!element.paused) element.pause()
        } else {
          const status = engine.harness.cutsceneStatus()
          if (status !== null) {
            const target = view.frame / status.fps
            if (Math.abs(element.currentTime - target) > AUDIO_TOLERANCE) {
              element.currentTime = target
            }
            const paused = engine.world.clock.paused
            if (paused && !element.paused) element.pause()
            if (!paused && element.paused) {
              /*
               * Once, and then it stops asking to be told.
               *
               * `play()` flips `paused` synchronously, so a promise that
               * resolves is never seen here again; one that rejects flips it
               * back and this fires on every frame of the scene. The swallowed
               * rejection is what hid the Safari activation refusal for as long
               * as it hid, so it is reported — and reported once, because 2742
               * identical warnings is the same silence in a louder font.
               */
              void element.play().catch((cause: unknown) => {
                if (refused.current) return
                refused.current = true
                log.warn('the reference track will not play', {
                  reason: cause instanceof Error ? cause.name : String(cause),
                })
              })
            }
          }
        }
      }
    }
    handle = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(handle)
  }, [engine])

  const source = engine.cutsceneAudio ?? adopted

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* The track, mounted for the life of the session rather than the life
          of a scene.

          It has to exist before the gesture that starts the scene, because
          that gesture is the only thing that can unlock it — see the primer
          above. Mounting it with the titles put it one render *after* the
          click on the library card, which is the render that starts the
          playback it was supposed to permit. It is also why this branch is
          the outer one: a `return null` for a scene that is not running would
          unmount the element between scenes and hand back the lock. */}
      {source !== null && <audio ref={audio} src={source} preload="auto" />}
      {texts === null ? null : (
        <>
          {/* The blackout sits over the scene and under the text: the opening
          card and the outro both put type over black.

          `hud-bleed` because it is picture rather than chrome. `.hud-layer`
          holds its children clear of the safe areas, which is right for
          everything that has to be read and wrong for this: a blackout that
          stopped at the notch would show a band of live scene above a title
          card. */}
          <div
            ref={blackout}
            className="hud-bleed absolute bg-black"
            style={{ opacity: 0 }}
          />
          {texts.map((text) => (
            <div
              key={text.id}
              ref={(node) => {
                if (node === null) lines.current.delete(text.id)
                else lines.current.set(text.id, node)
              }}
              style={textStyle(text)}
            >
              {text.label !== undefined && (
                <div style={labelStyle(text)}>{text.label}</div>
              )}
              {text.text}
            </div>
          ))}
          {/* The frame counter and the skip hint ride the debug transport: the
          cinema player has its own timecode and its own way out, and a second
          frame number in the corner of every capture is exactly the chrome a
          scene is supposed to be free of. */}
          {showTransport && (
            <div
              ref={hint}
              className="type-micro absolute right-3 bottom-2 text-slate-400"
              style={{ opacity: 0 }}
            />
          )}

          {showTransport && transport !== null && (
            <CutsceneTransport
              frame={transport.frame}
              durationFrames={transport.durationFrames}
              paused={transport.paused}
              onGrab={grab}
              onSeek={(frame) => {
                if (!seek(frame)) return
                engine.cutscene.seek(frame)
              }}
              // The same verb the cinema player's play button calls. It used to be
              // written out here as well, identically, against the clock.
              onTogglePlay={() => engine.cutscene.toggle()}
              onStop={() => engine.cutscene.stop()}
            />
          )}
        </>
      )}
    </div>
  )
}
