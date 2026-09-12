'use no memo'
import { useEffect, useRef, useState } from 'react'
import { getLogger } from '@inertialref/shared'
import type { CinematicTextState, GameEngine } from '../engine/GameEngine.ts'
import { soundtrackCandidates, soundtrackFor } from './cutsceneAudio.ts'
import { labelStyle, textStyle } from './cutsceneText.ts'
import { useAction, useKeyContext } from '../input/useKeymap.ts'
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
 * the console may write — the PerfPanel case exactly. React renders only the
 * *structure* (once per cutscene start/stop); the per-frame opacity and
 * transform writes go straight to the DOM nodes from a rAF loop, because
 * 24-fps-timed fades re-rendered through React at display rate would be all
 * reconcile and no picture.
 *
 * No transport and no frame counter. The cinema player owns the playhead's
 * controls, with a timecode and a shareable link, and a second transport here
 * — behind the debug overlay, for a scene started from another mode — was two
 * playheads a person could disagree with. It also had one frame to itself on
 * every way out of the player: the mode band leaves in the click's commit and
 * the store learns the scene has stopped a sample later, and the transport
 * rendered into that gap. `ir.pause()`, `ir.seekCutscene()` and Escape are
 * the verbs outside the player.
 */

const log = getLogger('game.cutscene')

/** How closely the audio element tracks the reference clock, seconds. */
const AUDIO_TOLERANCE = 0.08

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

export function CutsceneOverlay({ engine }: { engine: GameEngine }) {
  // Structure state only: which cutscene's text set is mounted. Polled slowly
  // — starting and stopping are human-rate events.
  const [texts, setTexts] = useState<readonly CinematicTextState[] | null>(null)
  /*
   * Which scene is open, from the same published playhead the cinema player
   * reads, so the two cannot disagree and neither costs a timer.
   */
  const transport = useEngine((snapshot) => snapshot.playhead)
  const blackout = useRef<HTMLDivElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const lines = useRef(new Map<string, HTMLDivElement>())
  /*
   * The tracks this deployment serves, by the name a script declares them
   * under, mirrored into state.
   *
   * `engine.cutsceneAudio` is a plain field and writing one schedules nothing,
   * so on the field alone the element mounted whenever something *else*
   * re-rendered this component — which, before a scene is open, is never. The
   * element has to exist before the first gesture (see the primer below), so
   * the probe's answer has to be able to cause a render.
   */
  const [adopted, setAdopted] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  )
  /** Whether a refused `play()` has already been reported. See the rAF loop. */
  const refused = useRef(false)
  /**
   * The file the open scene is cut to, or null for silence — read by the rAF
   * loop through a ref because the loop is registered once and the answer
   * changes with the scene.
   */
  const playing = useRef<string | null>(null)

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
   * Adopt each declared soundtrack this deployment has, in a format this
   * browser can decode.
   *
   * A track is copyrighted music and never enters the repository — the path
   * is gitignored, and `scripts/media.mjs` pulls it out of the site's R2 bucket
   * at build time — so a fork, a checkout without credentials and a local build
   * before the first pull all legitimately have no file there. Hence a probe
   * rather than an assumption: the scene plays silent when it is absent,
   * which is a scene without music rather than a broken one.
   *
   * Two questions per candidate, and both have to be asked. `canPlayType` is
   * free and local; the HEAD is neither, so it runs only for a format that
   * would be used. A deployment may carry one encoding, both, or neither.
   *
   * The names come from the scene library, so a scene with no soundtrack
   * asks for nothing. `engine.cutsceneAudio` stands in for every declared
   * track, for a differently named local file, and skips the probe.
   */
  useEffect(() => {
    if (engine.cutsceneAudio !== null) return
    let cancelled = false
    const decoder = document.createElement('audio')
    const names = new Set<string>()
    for (const scene of engine.harness.cutscenes()) {
      if (scene.soundtrack !== null) names.add(scene.soundtrack)
    }
    void (async () => {
      for (const name of names) {
        let found = false
        for (const candidate of soundtrackCandidates(name)) {
          if (decoder.canPlayType(candidate.type) === '') continue
          const response = await fetch(candidate.src, { method: 'HEAD' }).catch(
            () => null,
          )
          if (cancelled) return
          /*
           * `ok` is not enough, and the reason is the same one the Worker's
           * own media handler carries: a single-page fallback answers a path
           * it does not have with the document and a **200**. In production
           * the Worker 404s an unlisted name, but Vite's dev server does not —
           * so without the content-type check, a developer who has never run
           * `pnpm media:pull` hands an `<audio>` element `index.html` and gets
           * a decode error instead of a silent cutscene.
           */
          const type = response?.headers.get('content-type') ?? ''
          if (response?.ok !== true || !type.startsWith('audio/')) continue
          setAdopted((held) => new Map(held).set(name, candidate.src))
          found = true
          break
        }
        if (!found) {
          log.info('a soundtrack is not served here; its scene plays silent', {
            soundtrack: name,
          })
        }
      }
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
   * gesture, and the element is permitted for the rest of the page's life,
   * whichever file it is later pointed at. It is inaudible — the reference
   * track opens on two seconds of digital silence and this lasts a frame — and
   * it is why the element is mounted as soon as any track is adopted rather
   * than when a scene starts. The gesture that starts the scene is the click
   * on the library card, and an element that mounts in response to that click
   * has already missed it.
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
          // sounds and where it is. Left running only if a scene with music
          // is already playing, which is the case where this gesture was the
          // Play button.
          if (
            playing.current === null ||
            engine.cinematic === null ||
            engine.world.clock.paused
          ) {
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
      // tolerance — seeking every frame stutters the element. Only for a
      // scene that declares a track: a silent scene leaves the element
      // parked, whatever file it holds from the last one.
      const element = audio.current
      if (element !== null) {
        if (view === null || playing.current === null) {
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

  /*
   * The file for the open scene, and the file the element carries.
   *
   * The two differ when no scene is open, or the open one is silent: the
   * element then keeps whichever adopted track it has, so it exists to be
   * primed and the unlock survives between scenes, while `playing` says the
   * loop must leave it parked. The console's override stands in for every
   * declared track and for none of the undeclared ones.
   */
  const soundtrack = soundtrackFor(engine.harness.cutscenes(), sceneId)
  const track =
    soundtrack === null
      ? null
      : (engine.cutsceneAudio ?? adopted.get(soundtrack) ?? null)
  playing.current = track
  const source =
    track ?? engine.cutsceneAudio ?? adopted.values().next().value ?? null

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
        </>
      )}
    </div>
  )
}
