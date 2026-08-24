import { useEffect, useRef } from 'react'
import { TNG_CUTS, TNG_LENS } from '@inertialref/devtools'
import { Vec } from '@inertialref/spatial'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useEngine } from '../state/engineStore.ts'
import { loadReferenceTrack } from './referenceTrack.ts'
import {
  CHORD_STEP,
  frameToPixels,
  noseOf,
  offsetOf,
  offsetOfSample,
  projectHull,
  referenceAt,
  type ReferenceTrack,
  shotAt,
  VELOCITY_STEP,
} from './trackOverlay.ts'

/*
 * The reference edit's tracked subject, drawn over the scene it is being
 * compared against.
 *
 * Behind `ir.trackOverlay(true)`, off in a fresh page, and the reason it exists
 * is that the seek-and-compare loop was arithmetic: seek the render to f2100,
 * open the reference frame beside it, read `dcx` and `dw` out of a CSV, decide
 * whether the descent is late. Two boxes and two vectors answer the same
 * question by being looked at.
 *
 * ## What is drawn
 *
 * - The **reference's** box for this frame, as a dashed ghost, with a crosshair
 *   on its centroid. Nothing at all on the 1,103 frames it never tracked.
 * - The **render's** own hull, projected into the same authored 16:9 frame and
 *   boxed at `apparentWidth(TNG_HULL_LENGTH, range)` — the same quantity the
 *   tracker's `w` column reports, which is what makes the two boxes comparable.
 * - The hull's **nose**, and its velocity measured over two windows — a
 *   four-frame chord and a half-frame difference — as short vectors from it.
 *   Projected rather than merely drawn, so a vector pointing down the view axis
 *   shrinks to nothing instead of lying about a heading. `cinematics.md`'s
 *   "derive orientation from the path" is what the three of them make visible:
 *   where the nose leaves the path the hull is sliding — or banking, which is
 *   authored and legitimate — and where the two velocity windows leave each
 *   other, no finite difference is a heading worth reading.
 *
 * ## Why it is a rAF loop over three DOM nodes
 *
 * React renders the structure once per scene and never again. The numbers are
 * 24 fps against a display-rate render and change every frame, and reconciling
 * ten SVG attributes at 60 Hz to move a rectangle is all reconcile and no
 * picture — the same reasoning, and the same shape, as `CutsceneOverlay.tsx`
 * next door. Nothing here is state: the playhead is the director's, the flag is
 * the harness's, and the only thing this component owns is a cached size and a
 * cached fetch.
 *
 * ## Cost when it is off
 *
 * The component renders nothing and its rAF loop does not start unless a scene
 * is open — `playhead !== null`, a primitive selector, so the 8 Hz sampler does
 * not re-render it — and while one is, the loop reads one boolean off the
 * harness and returns. The 288 KB reference export is not fetched until the
 * flag is first turned on; see `referenceTrack.ts`.
 */

/** Hull colours: the reference is warm, the render is cold, and never both. */
const REFERENCE = '#fbbf24'
const RENDER = '#38bdf8'
const NOSE = '#6ee7b7'
const VELOCITY = '#f0abfc'

/**
 * How long a fully square-on vector draws, as a multiple of its projection.
 *
 * The projection is already about 7% of the frame's height, which is legible;
 * this stretches it to about 12% so the angle between the two vectors can be
 * read at a glance without either of them reaching the edge of the frame.
 */
const VECTOR_GAIN = 1.6

/** Keeps a label whose box has overrun the frame on screen anyway. */
const LABEL_MARGIN = 14
/** Roughly how wide a label runs, for the right-hand clamp. */
const LABEL_WIDTH = 210
/** The gap between two labels that have both been clamped to the same corner. */
const LABEL_ROW = 14

export function TrackOverlay({ engine }: { engine: GameEngine }) {
  /*
   * Structure gate: is a scene open at all.
   *
   * A boolean rather than the playhead itself. `snapshot.playhead` is a fresh
   * object every sample, so selecting it re-renders this component eight times
   * a second for a frame number that the rAF loop is already reading from the
   * engine — see the note on narrow selectors in `.claude/rules/react-shell.md`.
   */
  const open = useEngine((snapshot) => snapshot.playhead !== null)

  const root = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const readout = useRef<HTMLDivElement>(null)
  const numbers = useRef<HTMLSpanElement>(null)
  const referenceGroup = useRef<SVGGElement>(null)
  const referenceBox = useRef<SVGRectElement>(null)
  const referenceCross = useRef<SVGPathElement>(null)
  const referenceLabel = useRef<SVGTextElement>(null)
  const renderGroup = useRef<SVGGElement>(null)
  const renderBox = useRef<SVGRectElement>(null)
  const renderLabel = useRef<SVGTextElement>(null)
  const noseLine = useRef<SVGLineElement>(null)
  const velocityLine = useRef<SVGLineElement>(null)
  const instantLine = useRef<SVGLineElement>(null)
  const hullDot = useRef<SVGCircleElement>(null)

  /** The element's own box, remeasured on resize rather than read per frame. */
  const size = useRef({ width: 0, height: 0 })
  /** The reference track once it has arrived; null until then and if it never does. */
  const track = useRef<ReferenceTrack | null>(null)
  /** Whether the export has been asked for. It is fetched at most once. */
  const requested = useRef(false)

  useEffect(() => {
    const node = root.current
    if (node === null) return
    const measure = (): void => {
      size.current = { width: node.clientWidth, height: node.clientHeight }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [open])

  useEffect(() => {
    // Gated on `open`, which is what makes the note above true: the component
    // is mounted unconditionally by `App.tsx` and only its *render* returns
    // null, so without this the loop ran in the menu, in flight and in the
    // planetarium for the whole session.
    if (!open) return
    let handle = 0
    const tick = (): void => {
      handle = window.requestAnimationFrame(tick)

      // The whole cost of an overlay that is off: one property read.
      const on = engine.harness.trackOverlayShowing
      /*
       * Reconciled against the node rather than latched against the last value.
       *
       * `ir.trackOverlay(true)` is typed at a console before the scene is open
       * as often as after — and this component renders null until the playhead
       * is published, which is up to an eighth of a second later. An edge test
       * consumes the change on a frame when there is no element to write to
       * and never fires again, which is how this first shipped: the flag was
       * on, the readout was filling in, and the SVG stayed at the `display:
       * none` React gave it. Comparing what the node already says is idempotent
       * and costs an inline-style read, which forces no layout.
       */
      show(svg.current, on)
      show(readout.current, on)
      if (!on) return
      /*
       * First switch-on is what pays for the 288 KB export.
       *
       * The ref is an allocation guard, not a correctness latch — the rule
       * against those is real and this is not one. `loadReferenceTrack` owns
       * "once" at module scope and hands back the same promise however often it
       * is called; the guard is only so a rAF loop does not allocate a `.then`
       * sixty times a second while the fetch is in flight, or forever after one
       * that failed.
       */
      if (!requested.current) {
        requested.current = true
        void loadReferenceTrack().then((loaded) => {
          track.current = loaded
        })
      }

      const view = engine.cinematic
      const status = engine.harness.cutsceneStatus()
      const line = numbers.current
      if (view === null || status === null) {
        show(referenceGroup.current, false)
        show(renderGroup.current, false)
        return
      }
      /*
       * The lens and the track both belong to this one script. A second scene
       * would be projected through the wrong field of view and compared against
       * somebody else's boxes, which is a wrong picture rather than a missing
       * one — so it says so instead.
       */
      if (status.id !== 'tng-intro') {
        show(referenceGroup.current, false)
        show(renderGroup.current, false)
        if (line !== null)
          line.textContent = `${status.id} · no reference track`
        return
      }

      const frame = view.frame
      const { width, height } = size.current
      if (height <= 0) return
      const map = frameToPixels(width, height)

      /*
       * The velocity, from the sampler and not from the last rendered frame.
       *
       * A central difference of the hull's camera-relative offset half a frame
       * either side. Differencing consecutive rAF ticks instead would read zero
       * whenever the scene is paused — which is every frame of the capture loop
       * this exists to serve — and a spike on the tick after a seek. Clamped at
       * the ends of the scene, and the divisor is the span that survived the
       * clamp rather than the one that was asked for.
       */
      const last = status.durationFrames - 1
      /*
       * Clipped to the shot, not just to the scene.
       *
       * Two shots have two stage anchors, so a window that straddles a cut
       * differences two unrelated places: measured at f1092 — the warp-out
       * this overlay exists to inspect — the half-frame window read 1.9e4 m
       * per frame against 3.14 the frame after. The vector is normalized
       * before it is drawn, so what that produces is a nose-and-velocity fan
       * pointing along an inter-shot jump, with a `v` readout to match.
       */
      const shot = TNG_CUTS.find(
        (one) => Math.round(frame) >= one.from && Math.round(frame) <= one.to,
      )
      const lo = shot === undefined ? 0 : shot.from
      const hi = shot === undefined ? last : Math.min(shot.to, last)
      const difference = (half: number) => {
        const from = Math.max(lo, Math.min(frame - half, hi))
        const to = Math.max(lo, Math.min(frame + half, hi))
        const before = engine.harness.cutscenePeek(from)
        const after = engine.harness.cutscenePeek(to)
        const span = to - from
        if (before === null || after === null || span < 1e-6) return Vec.ZERO
        return Vec.scale(
          Vec.sub(offsetOfSample(after), offsetOfSample(before)),
          1 / span,
        )
      }

      const offset = offsetOf(view.camera, view.ship)
      const nose = noseOf(view.camera.orientation, view.ship.orientation)
      const hull = projectHull(
        offset,
        nose,
        difference(CHORD_STEP),
        difference(VELOCITY_STEP),
      )

      /* The reference's box, where it has one. */
      const reference = referenceAt(track.current, frame)
      show(referenceGroup.current, reference !== null)
      if (reference !== null) {
        const boxWidth = reference.w * map.scale * TNG_LENS.aspect
        const boxHeight = reference.h * map.scale
        const cx = map.x(reference.cx)
        const cy = map.y(reference.cy)
        const rect = referenceBox.current
        if (rect !== null) {
          /*
           * The box is the extent of the lit mass; `cx`/`cy` is its
           * area-weighted centroid, which is not the middle of that extent — a
           * bright nacelle drags it. Drawing the extent *about* the centroid
           * puts the two channels the diff actually reads, `dcx` and `dw`, in
           * one shape, and the crosshair is what keeps the difference between
           * the centroid and the middle of the box visible rather than
           * flattened into it.
           */
          rect.setAttribute('x', String(cx - boxWidth / 2))
          rect.setAttribute('y', String(cy - boxHeight / 2))
          rect.setAttribute('width', String(Math.max(1, boxWidth)))
          rect.setAttribute('height', String(Math.max(1, boxHeight)))
        }
        const cross = referenceCross.current
        if (cross !== null) {
          cross.setAttribute(
            'd',
            `M${cx - 8} ${cy}H${cx + 8}M${cx} ${cy - 8}V${cy + 8}`,
          )
        }
        const label = referenceLabel.current
        if (label !== null) {
          place(label, cx - boxWidth / 2, cy - boxHeight / 2 - 6, width, 0)
          label.textContent =
            `ref ${reference.cx.toFixed(3)}, ${reference.cy.toFixed(3)} ` +
            `w ${reference.w.toFixed(3)}`
        }
      }

      /* The render's own hull, in the same coordinates. */
      show(renderGroup.current, view.ship.visible)
      const hx = map.x(hull.x)
      const hy = map.y(hull.y)
      /*
       * Square in pixels, because `apparentWidth` answers one question — how
       * much of the frame the hull's length covers — and a second axis would
       * have to invent an attitude-dependent height that the reference's own
       * `h` is not measuring either.
       */
      const side = hull.width * map.scale * TNG_LENS.aspect
      const box = renderBox.current
      if (box !== null) {
        box.setAttribute('x', String(hx - side / 2))
        box.setAttribute('y', String(hy - side / 2))
        box.setAttribute('width', String(Math.max(1, side)))
        box.setAttribute('height', String(Math.max(1, side)))
      }
      if (hullDot.current !== null) {
        hullDot.current.setAttribute('cx', String(hx))
        hullDot.current.setAttribute('cy', String(hy))
      }
      const vector = (
        node: SVGLineElement | null,
        dx: number,
        dy: number,
      ): void => {
        if (node === null) return
        node.setAttribute('x1', String(hx))
        node.setAttribute('y1', String(hy))
        node.setAttribute(
          'x2',
          String(hx + dx * map.scale * TNG_LENS.aspect * VECTOR_GAIN),
        )
        node.setAttribute('y2', String(hy + dy * map.scale * VECTOR_GAIN))
      }
      vector(noseLine.current, hull.nose.dx, hull.nose.dy)
      vector(velocityLine.current, hull.velocity.dx, hull.velocity.dy)
      /*
       * The local half-frame difference, faint, under the smoothed chord.
       *
       * Drawn rather than summarised away, because the gap between them is the
       * reading and neither one is the answer: where the two lie on top of each
       * other the hull is on a line and its heading is whatever they both say,
       * and where the faint one fans away from the dashed one the path is
       * turning or wobbling inside the window and no finite difference is a
       * heading at all. `jitterDeg` is the same fact as a number.
       */
      vector(instantLine.current, hull.instant.dx, hull.instant.dy)
      const renderText = renderLabel.current
      if (renderText !== null) {
        place(renderText, hx - side / 2, hy - side / 2 - 6, width, 1)
        renderText.textContent =
          `render ${hull.x.toFixed(3)}, ${hull.y.toFixed(3)} ` +
          `w ${hull.width.toFixed(3)}`
      }

      if (line !== null) {
        const delta =
          reference === null
            ? 'no reference'
            : `d ${(hull.x - reference.cx).toFixed(3)}, ` +
              `${(hull.y - reference.cy).toFixed(3)} ` +
              `dw ${(hull.width - reference.w).toFixed(3)}`
        line.textContent =
          `${status.id} · ${shotAt(frame)} · f${Math.floor(frame)} · ` +
          `${delta} · range ${formatRange(hull.range)} · ` +
          `v ${hull.speed.toFixed(1)} m/f · nose ${percent(hull.nose.foreshortening)} · ` +
          `jitter ${hull.jitterDeg.toFixed(1)}°`
      }
    }
    handle = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(handle)
  }, [engine, open])

  if (!open) return null

  return (
    /*
     * `hud-bleed`, because this is picture rather than chrome: it draws in the
     * same coordinate space as the rendered frame, so a box that stopped at the
     * safe area would be a box in the wrong place — the same argument
     * `CutsceneOverlay.tsx`'s blackout makes, and the reason neither of them is
     * laid out against the viewport. `flex items-end` is the other half:
     * `hud-bleed` pads the insets back and padding reaches only an *in-flow*
     * child, so the corner readout is laid out rather than positioned.
     */
    <div
      ref={root}
      className="hud-bleed pointer-events-none absolute flex items-end"
    >
      <svg
        ref={svg}
        className="absolute inset-0 h-full w-full"
        style={{ display: 'none' }}
        aria-hidden="true"
      >
        <g ref={referenceGroup} style={{ display: 'none' }}>
          <rect
            ref={referenceBox}
            fill="none"
            stroke={REFERENCE}
            strokeWidth={1.5}
            strokeDasharray="6 4"
            opacity={0.85}
          />
          <path
            ref={referenceCross}
            fill="none"
            stroke={REFERENCE}
            strokeWidth={1.5}
            opacity={0.85}
          />
          <text
            ref={referenceLabel}
            fill={REFERENCE}
            stroke="#000"
            strokeWidth={3}
            paintOrder="stroke"
            fontSize={11}
            fontFamily="ui-monospace, monospace"
          />
        </g>
        <g ref={renderGroup} style={{ display: 'none' }}>
          <rect
            ref={renderBox}
            fill="none"
            stroke={RENDER}
            strokeWidth={1.5}
            opacity={0.9}
          />
          <circle ref={hullDot} r={2.5} fill={RENDER} />
          <line ref={noseLine} stroke={NOSE} strokeWidth={2.5} />
          {/* Faint and beneath the dashed chord: the local half-frame
              difference, so how far the two windows disagree is visible as a
              fan rather than only as `jitter` in the readout. */}
          <line
            ref={instantLine}
            stroke={VELOCITY}
            strokeWidth={1.5}
            opacity={0.45}
          />
          <line
            ref={velocityLine}
            stroke={VELOCITY}
            strokeWidth={2.5}
            strokeDasharray="5 3"
          />
          <text
            ref={renderLabel}
            fill={RENDER}
            stroke="#000"
            strokeWidth={3}
            paintOrder="stroke"
            fontSize={11}
            fontFamily="ui-monospace, monospace"
          />
        </g>
      </svg>
      {/* The corner readout, and the key to the four colours.
          The words are structure and never change; only the numbers are
          written per frame, into the one span that holds them. */}
      <div
        ref={readout}
        className="type-micro m-3 flex items-center gap-2 rounded bg-slate-950/70 px-1.5 py-1 text-slate-300"
        style={{ display: 'none' }}
      >
        <span ref={numbers} />
        <span style={{ color: REFERENCE }}>Reference</span>
        <span style={{ color: RENDER }}>Render</span>
        <span style={{ color: NOSE }}>Nose</span>
        <span style={{ color: VELOCITY }}>Velocity</span>
      </div>
    </div>
  )
}

/**
 * Put a label at a box's top-left corner, or as near to it as the frame allows.
 *
 * Both boxes routinely overrun the frame — the reference's is the whole lit
 * mass, and at f916 the hull fills the picture — so the corner they are
 * anchored to is off screen more often than not, and an unclamped label simply
 * is not drawn. Clamped, it slides along the edge and stays readable, which
 * costs the exactness of where it points and buys the number being visible at
 * all.
 *
 * `row` is the other half, and it is not cosmetic: when *both* boxes overrun
 * the same corner both labels clamp to the same pixel and print on top of each
 * other, which at f916 turned two readings into `render307327,3054870w909945`.
 * A row apiece means the clamped case degrades to a stack rather than to a
 * jumble.
 */
function place(
  node: SVGTextElement,
  x: number,
  y: number,
  width: number,
  row: number,
): void {
  const left = Math.min(
    Math.max(x, LABEL_MARGIN),
    Math.max(LABEL_MARGIN, width - LABEL_WIDTH),
  )
  node.setAttribute('x', String(left))
  node.setAttribute('y', String(Math.max(LABEL_MARGIN + row * LABEL_ROW, y)))
}

/** Show or hide an element, writing only when it does not already say so. */
function show(node: SVGElement | HTMLElement | null, visible: boolean): void {
  const want = visible ? '' : 'none'
  if (node !== null && node.style.display !== want) node.style.display = want
}

/** Meters up to a thousand kilometers, then kilometers. */
function formatRange(meters: number): string {
  return meters < 1e6
    ? `${Math.round(meters).toLocaleString('en-US')} m`
    : `${Math.round(meters / 1000).toLocaleString('en-US')} km`
}

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`
