'use no memo'
import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { ArrowDownToLine, PersonStanding } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Action } from '../hud/Action.tsx'
import { formatReading } from '@inertialref/shared'
import type { GameEngine } from '../engine/GameEngine.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { describeCause } from '../hud/notice.ts'
import { useEngine } from '../state/engineStore.ts'
import { heldDropFromScreen } from './entryAid.ts'
import { useSurveySites } from './useSurveySites.ts'

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
  const reducedMotion = useReducedMotion()
  const standing = useEngine((snapshot) => snapshot.observer?.surface != null)
  const dropping = useEngine((snapshot) => snapshot.observer?.descent != null)
  const progress = useEngine(
    (snapshot) => snapshot.observer?.descent?.progress ?? 0,
  )
  const height = useEngine(
    (snapshot) => snapshot.observer?.surface?.stance.height ?? 0,
  )
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

  // Coordinates stay with the scene's owner. React only needs gesture state.
  const [aim, setAim] = useState<'outside' | 'ground' | null>(null)
  const live = useRef<{
    x: number
    y: number
    pointerId: number
    address: string | null
  } | null>(null)
  const travelled = useRef(0)
  const dragging = aim !== null
  const guiding = dragging || dropping
  useEffect(() => {
    if (!guiding) return
    const layer = engine.presentation.push({ showOrbits: false, labels: false })
    return () => layer.release()
  }, [engine, guiding])

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
      if (pointer.address !== observatory.target?.address) {
        observatory.previewDrop(null)
        setAim('outside')
        return
      }
      const held = heldDropFromScreen(engine, pointer, viewportSize())
      if (held === null) observatory.previewDrop(null)
      else observatory.previewLaunch(held.hold, held.up)
      setAim(observatory.aim === null ? 'outside' : 'ground')
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
  if (!dragging && (standing || dropping))
    return (
      <div className="pointer-events-auto absolute bottom-16 left-3 sm:bottom-3 flex max-w-[calc(100%-1.5rem)] flex-col gap-2 rounded-lg border border-slate-700/60 bg-slate-950/85 p-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <ArrowDownToLine
            aria-hidden
            className="size-4 shrink-0 text-sky-300"
          />
          <div className="min-w-0">
            <p role="status" className="type-label text-sky-200">
              {dropping ? 'Descending' : 'On the ground'}
            </p>
            <p className="type-readout truncate text-slate-300">
              {name} · {formatReading(height)} above ground
            </p>
          </div>
          <Action
            label="Return to orbit"
            onClick={() => engine.harness.ascend()}
          />
        </div>
        {dropping && (
          <div
            role="progressbar"
            aria-label="Descent"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-px overflow-hidden bg-slate-700"
          >
            <div
              className="h-full origin-left bg-sky-300 transition-transform duration-150 motion-reduce:transition-none"
              style={{ transform: `scaleX(${progress})` }}
            />
          </div>
        )}
      </div>
    )
  if (!dragging && (!landable || radius <= 0)) return null

  const begin = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (live.current !== null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    travelled.current = 0
    live.current = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      address: engine.harness.observatory.target?.address ?? null,
    }
    setAim('outside')
  }

  const move = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (live.current === null || live.current.pointerId !== event.pointerId)
      return
    const previous = live.current
    travelled.current += Math.hypot(
      event.clientX - previous.x,
      event.clientY - previous.y,
    )
    // Into the ref only. The frame loop above is what turns a pointer position
    // into an arc, so a move event that also projected would do the work twice
    // and draw the older of the two answers.
    live.current = { ...previous, x: event.clientX, y: event.clientY }
  }

  const release = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const pointer = live.current
    if (pointer === null || pointer.pointerId !== event.pointerId) return
    // React keeps only hit/miss for the label. The observatory owns the
    // coordinates currently drawn, including motion across one valid region.
    const observatory = engine.harness.observatory
    const held =
      pointer.address === observatory.target?.address ? observatory.aim : null
    const node = event.currentTarget
    live.current = null
    if (node.hasPointerCapture(event.pointerId))
      node.releasePointerCapture(event.pointerId)
    setAim(null)
    engine.harness.observatory.previewDrop(null)
    // A press that never travelled is somebody discovering the control, not a
    // drop onto whatever happens to be under a resting cursor.
    if (event.type === 'pointerup' && travelled.current < CLICK_SLOP) {
      onNotice(`Drag onto ${name ?? 'the world'} to stand there.`)
      return
    }
    if (event.type !== 'pointerup' || held === null) return
    try {
      // Through the harness, so the console verb and this gesture are one call
      // and cannot drift on the degrees/radians boundary — `ir.drop` takes
      // degrees and the arm under it takes radians.
      engine.harness.drop(
        (held.latitude * 180) / Math.PI,
        (held.longitude * 180) / Math.PI,
        reducedMotion ? { seconds: 0.1 } : {},
      )
    } catch (cause) {
      onNotice(describeCause(cause))
    }
  }

  return (
    <div
      className={`pointer-events-auto absolute bottom-16 left-3 sm:bottom-3 max-w-[calc(100%-1.5rem)] rounded-lg border bg-slate-950/85 backdrop-blur transition-colors ${dragging ? 'border-sky-400/60' : 'border-slate-700/60'}`}
    >
      <Button
        type="button"
        variant="ghost"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        title={`Drag onto ${name ?? 'the world'} to stand there`}
        aria-label={`Drag onto ${name ?? 'the world'} to stand there`}
        className={`h-auto min-h-11 cursor-grab touch-none gap-3 rounded-lg px-3 py-2 text-sky-300 hover:bg-sky-500/15 hover:text-sky-200 active:cursor-grabbing ${FOCUS_RING}`}
      >
        <PersonStanding aria-hidden className="size-5 shrink-0" />
        <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
          <span role="status" className="type-label text-sky-200">
            {aim === 'ground'
              ? 'Release to land'
              : dragging
                ? 'Choose a landing site'
                : 'Drag to stand'}
          </span>
          <span className="type-ui max-w-48 truncate text-slate-400">
            {aim === 'ground'
              ? `On ${name ?? 'the world'} · Follow the ring`
              : `Onto ${name ?? 'the world'}`}
          </span>
        </span>
      </Button>
    </div>
  )
}
