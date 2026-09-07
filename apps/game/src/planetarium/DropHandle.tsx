'use no memo'
import { useEffect, useRef, useState } from 'react'
import { PersonStanding } from 'lucide-react'
import type { GameEngine } from '../engine/GameEngine.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { describeCause } from '../hud/notice.ts'
import { useEngine } from '../state/engineStore.ts'
import { rayFromScreen } from './entryAid.ts'
import { useSurveySites } from './useSurveySites.ts'

/*
 * Put a person on that world.
 *
 * The planetarium can already stand on a surface — the Ground section's site
 * buttons cut straight to the summit or the shoreline — and what it could not
 * do is let somebody choose *that spot, there*, on the disk they are looking
 * at. Typing a latitude into a sphere lands on the same undifferentiated
 * mid-slope every time, which is the argument `surveySites` was written from;
 * a pointer aimed at a place on a drawn planet is the other way to answer it,
 * and the only one that works for a world nobody has named anything on.
 *
 * The gesture is a drag rather than a click because the camera already spends
 * every click it has: a click in the sky focuses whatever it hits, and taking
 * that away — or overloading it with a modifier — would cost the mode its
 * primary verb to add a rarer one. Picking the figure up is an unambiguous
 * statement of intent, the arc under the pointer is the answer to "where would
 * that put me", and letting go is the commit. Nothing is decided until then.
 *
 * **Nothing here draws the aid.** This sets the observatory's aim and the
 * scene draws it — `scene/EntryTrace.tsx` — because the arc and its rings are
 * things in the world rather than marks over it: the fall has to pass behind a
 * limb, the ring on the ground has to be the ellipse a circle on a sphere
 * really is, and the dashes have to shorten with distance. An overlay in the
 * HUD can do none of those, which is what it was before.
 *
 * `'use no memo'`: the hit test runs from the engine inside a frame loop, which
 * is mutable state the compiler cannot see changing.
 */

/** Movement under this, in pixels, and the press was a click on the handle. */
const CLICK_SLOP = 4

const viewportSize = (): { width: number; height: number } => ({
  width: window.innerWidth,
  height: window.innerHeight,
})

export function DropHandle({
  engine,
  target,
  onNotice,
}: {
  readonly engine: GameEngine
  /** The address the mode considers current. */
  readonly target: string | null
  readonly onNotice: (message: string) => void
}) {
  /*
   * Scalars, never the status object: `observer` is a fresh object graph on
   * every one of the eight samples a second, so selecting it would rebuild
   * this at that rate beside a camera that has not moved.
   */
  const standing = useEngine((snapshot) => snapshot.observer?.surface != null)
  const dropping = useEngine((snapshot) => snapshot.observer?.descent != null)
  const radius = useEngine((snapshot) => snapshot.observer?.target?.radius ?? 0)
  const name = useEngine((snapshot) => snapshot.observer?.target?.name ?? null)
  /*
   * Whether there is ground to stand on, from the survey the Ground section
   * already asks for — `surveySites` memoizes per body, so the second reader
   * is a map lookup rather than a second beam search. `null` is "not answered
   * yet" and is not the same as "nowhere to stand": drawing the handle for a
   * frame on a gas giant would be a control that refuses the first time it is
   * used.
   */
  const sites = useSurveySites(engine, target)
  const landable = sites !== null && sites.length > 0

  /** What the drag is over, or null when nothing is dragging. */
  const [aim, setAim] = useState<{
    readonly hit: { latitude: number; longitude: number } | null
  } | null>(null)
  // Read by the frame loop, which outlives any one render.
  const live = useRef<{ x: number; y: number } | null>(null)
  const travelled = useRef(0)
  /*
   * Whether a gesture is in flight, as the one thing the loop's lifetime turns
   * on. The loop writes `aim` on most frames and must not be torn down and
   * rebuilt by its own write, so it depends on this boolean rather than on the
   * state it is producing.
   */
  const dragging = aim !== null

  /*
   * The aim is recast every frame rather than on every pointer move, and the
   * difference shows the moment the clock is running: the touchdown is a
   * latitude on a *turning* body, so a point taken once at the last mouse
   * event slides off the ground it was aimed at. At 1× that is slow enough to
   * look like lag and at 100,000× it is the whole point of the mode.
   *
   * The observatory is told, and the scene reads it there. Only the hit or
   * miss reaches React state, because that is all this component draws with —
   * the button's own label, and whether a release would land.
   */
  useEffect(() => {
    if (!dragging) return
    const observatory = engine.harness.observatory
    let handle = 0
    const tick = (): void => {
      handle = window.requestAnimationFrame(tick)
      const pointer = live.current
      if (pointer === null) return
      const ray = rayFromScreen(engine, pointer, viewportSize())
      const hit =
        ray === null ? null : observatory.groundUnderRay(undefined, ray)
      observatory.previewDrop(hit)
      setAim((held) =>
        // Identity while the answer has not changed in kind, so a drag across
        // a world is not sixty React renders a second for one boolean.
        held !== null && (held.hit === null) === (hit === null)
          ? held
          : { hit: hit === null ? null : { ...hit } },
      )
    }
    handle = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(handle)
      // The aid belongs to the gesture. A drag that ends by unmounting — a
      // route change, a world replaced under it — must not leave a curve
      // hanging over the sky with nothing holding it.
      observatory.previewDrop(null)
    }
  }, [engine, dragging])

  /*
   * A control being dragged does not vanish from under the drag.
   *
   * Every condition here can change while a finger is down — the camera can be
   * retargeted from the navigator, a survey can answer, a body can go away with
   * the world that held it — and unmounting the button mid-gesture drops its
   * pointer capture, which ends the drag silently: the arc freezes where it was
   * and the release lands nowhere. So the test is only asked when no drag is in
   * flight, and a drag that is already running is allowed to finish and be
   * refused on its merits by `drop`.
   */
  if (!dragging && (standing || dropping || !landable || radius <= 0))
    return null

  const begin = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    travelled.current = 0
    live.current = { x: event.clientX, y: event.clientY }
    setAim({ hit: null })
  }

  const move = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (live.current === null) return
    const previous = live.current
    travelled.current += Math.hypot(
      event.clientX - previous.x,
      event.clientY - previous.y,
    )
    // Into the ref only. The frame loop above is what turns a pointer position
    // into an arc, so a move event that also projected would do the work twice
    // and draw the older of the two answers.
    live.current = { x: event.clientX, y: event.clientY }
  }

  const release = (event: React.PointerEvent<HTMLButtonElement>): void => {
    // React keeps only hit/miss for the label. The observatory owns the
    // coordinates currently drawn, including motion across one valid region.
    const held = engine.harness.observatory.aim
    const node = event.currentTarget
    if (node.hasPointerCapture(event.pointerId))
      node.releasePointerCapture(event.pointerId)
    live.current = null
    setAim(null)
    engine.harness.observatory.previewDrop(null)
    if (held === null) return
    // A press that never travelled is somebody discovering the control, not a
    // drop onto whatever happens to be under a resting cursor.
    if (travelled.current < CLICK_SLOP) {
      onNotice(`Drag onto ${name ?? 'the world'} to stand there.`)
      return
    }
    if (event.type !== 'pointerup') return
    try {
      // Through the harness, so the console verb and this gesture are one call
      // and cannot drift on the degrees/radians boundary — `ir.drop` takes
      // degrees and the arm under it takes radians.
      engine.harness.drop(
        (held.latitude * 180) / Math.PI,
        (held.longitude * 180) / Math.PI,
      )
    } catch (cause) {
      onNotice(describeCause(cause))
    }
  }

  return (
    <>
      <div className="pointer-events-auto absolute bottom-4 left-4 flex items-center gap-2 rounded-lg border border-slate-700/60 bg-slate-950/85 py-1 pr-2.5 pl-1 backdrop-blur">
        <button
          type="button"
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={release}
          onPointerCancel={release}
          title={`Drag onto ${name ?? 'the world'} to stand there`}
          aria-label={`Drag onto ${name ?? 'the world'} to stand there`}
          className={`flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded text-sky-300 transition-colors hover:bg-sky-500/15 hover:text-sky-200 active:cursor-grabbing ${FOCUS_RING}`}
        >
          <PersonStanding aria-hidden className="size-5" />
        </button>
        {/* The label is the instruction, and it is the whole of the control's
            discoverability: a figure alone is a glyph nobody has a verb for. */}
        <span className="type-label hidden text-sky-400/80 sm:inline">
          Drag to stand
        </span>
      </div>
    </>
  )
}
