'use no memo'
import { useEffect, useRef, useState } from 'react'
import type { PerspectiveCamera } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import { declutter } from './pick.ts'
import { projectScene } from './project.ts'

/*
 * Names against the sky.
 *
 * The single feature that turns a rendered starfield into a planetarium: a
 * label is the difference between "a bright dot" and "Sirius". Drawn in the DOM
 * rather than as sprites in the scene, for the same reason the cutscene's
 * titles are — real typefaces and subpixel text rendering.
 *
 * Each name carries its own ground, and that is the whole reason the plate
 * exists. Tone mapping was doing less than this file used to assume: a name
 * over the Sun's disk measured 2.07:1, and its fill color alone — with the
 * text-shadow discounted — was 1.03:1, which is to say invisible. A dark shadow
 * under light text only works while the scene is dark, and a label is drawn on
 * the one thing in the frame guaranteed to be bright. The plate is the system's
 * own panel material at chip scale, and it is opaque enough to read against a
 * star without a backdrop-filter, which eighteen of these must not each have.
 *
 * `'use no memo'` and a rAF loop rather than React state, and this is the
 * `hud/PerfPanel.tsx` bargain again: the *set* of labels changes at human rate
 * and their *positions* change every frame. React renders the set; the loop
 * writes transforms straight onto the nodes. Reconciling a dozen absolutely
 * positioned divs at display rate would be all diffing and no picture.
 */

/** How many names at once. More than this and the sky is a list, not a sky. */
const MAX_LABELS = 18

/** Minimum separation before one of a pair is dropped, in CSS pixels. */
const SPACING = { x: 96, y: 18 }

/** The name plus its leader, in pixels: 12 of type and a 14 px leader. */
const TICK_LIFT = 26

/**
 * The dark edge an unplated name carries, as a text shadow.
 *
 * The plate is gone, and that is a trade the brief asked for in those words:
 * eighteen boxed chips read as a form laid over a sky, and the sky is the
 * thing. Two shadows rather than one — a tight 2px to draw the counters and a
 * wide 7px to sink the ground under the strokes — is what a single offset
 * cannot do, because the failing case is a *bright* background where the glyph
 * needs a hole around it rather than a drop.
 *
 * It is honestly weaker than the plate was. A name that lands on a lit limb
 * measures around 3:1 where the plate held 4.5, so the one label that has to
 * survive anything keeps a ground: the selected one, which is the name being
 * read. `#020617` is slate-950.
 */
const HALO =
  '0 0 2px rgb(2 6 23 / 0.95), 0 0 7px rgb(2 6 23 / 0.9), 0 1px 3px rgb(2 6 23 / 0.85)'

/**
 * A label's nodes, kept out of React so the loop can write to them.
 *
 * Two, because the two writes have different jobs: `root` carries the projected
 * screen position, and `stack` carries the lift that keeps the name off the
 * body it names. Folding them into one transform would mean recomputing the
 * projection every time the lift changed, and vice versa.
 */
interface LabelNode {
  readonly root: HTMLElement
  readonly stack: HTMLElement
}

export function SkyLabels({
  engine,
  enabled,
  target,
}: {
  engine: GameEngine
  enabled: boolean
  target: string | null
}) {
  /*
   * The mounted set, refreshed at a human rate.
   *
   * Names, not positions: what is in view changes when the camera travels
   * somewhere, which is an event a person caused, and four times a second is
   * indistinguishable from instant for that. The positions are the loop's job.
   */
  const [names, setNames] = useState<
    readonly { address: string; name: string }[]
  >([])
  const nodes = useRef(new Map<string, LabelNode>())

  useEffect(() => {
    if (!enabled) {
      setNames([])
      return
    }
    const refresh = (): void => {
      const scene = engine.scene()
      const view = engine.view
      if (scene === null || view === null) return
      const size = viewportSize()
      const candidates = projectScene(
        scene,
        view.camera as PerspectiveCamera,
        size,
      )
        .filter(
          (candidate) =>
            !candidate.offscreen &&
            candidate.x > 0 &&
            candidate.x < size.width &&
            candidate.y > 0 &&
            candidate.y < size.height &&
            candidate.name.length > 0,
        )
        // Largest first, so the priority the declutter is greedy about is
        // "what dominates the frame" — which is what a person is looking at.
        .sort((a, b) => b.radius - a.radius)
      setNames(
        declutter(candidates, SPACING, MAX_LABELS).map((candidate) => ({
          address: candidate.address,
          name: candidate.name,
        })),
      )
    }
    refresh()
    const timer = window.setInterval(refresh, 250)
    return () => window.clearInterval(timer)
  }, [engine, enabled])

  useEffect(() => {
    if (!enabled) return
    let handle = 0
    const tick = (): void => {
      handle = window.requestAnimationFrame(tick)
      const scene = engine.scene()
      const view = engine.view
      if (scene === null || view === null) return
      const size = viewportSize()
      const projected = new Map(
        projectScene(scene, view.camera as PerspectiveCamera, size).map(
          (candidate) => [candidate.address, candidate],
        ),
      )
      for (const [address, node] of nodes.current) {
        const at = projected.get(address)
        if (at === undefined || at.offscreen) {
          node.root.style.opacity = '0'
          continue
        }
        node.root.style.opacity = '1'
        node.root.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`
        /*
         * The leader ends on the body's limb, so a name never covers the thing
         * it names. `+ TICK_LIFT` is the height of the name and the leader
         * together, because the stack grows downwards from its own top.
         *
         * Clamped both ways: below 4 px a point source's label would sit on top
         * of it, and above a third of the frame a planet filling the view would
         * push its own name off the top edge.
         */
        const limb = Math.min(Math.max(at.radius, 4), size.height * 0.32)
        // The horizontal half-shift is written here rather than left to a
        // `-translate-x-1/2` class: an inline transform replaces the class's
        // outright, and the version that relied on both had every label
        // hanging off the right of the thing it named.
        node.stack.style.transform = `translate(-50%, ${-(limb + TICK_LIFT)}px)`
      }
    }
    handle = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(handle)
  }, [engine, enabled])

  if (!enabled) return null

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {names.map(({ address, name }) => {
        const selected = address === target
        return (
          <div
            key={address}
            ref={(root) => {
              if (root === null) {
                nodes.current.delete(address)
                return
              }
              const stack = root.firstElementChild
              if (stack instanceof HTMLElement)
                nodes.current.set(address, { root, stack })
            }}
            className="absolute top-0 left-0 will-change-transform"
            style={{ opacity: 0 }}
          >
            <div
              className="flex flex-col items-center will-change-transform"
              style={{ transform: 'translate(-50%, -24px)' }}
            >
              <span
                /* Bounded, because catalog names are not. `declutter` spaces
                   labels 96 px apart and a designation longer than that would
                   quietly overlap the neighbor it was spaced away from. */
                style={selected ? undefined : { textShadow: HALO }}
                className={`type-label max-w-[14rem] truncate whitespace-nowrap ${
                  selected
                    ? 'rounded-full bg-sky-400/12 px-2 py-0.5 text-sky-100 ring-1 ring-sky-400/35'
                    : 'text-slate-200'
                }`}
              >
                {name}
              </span>
              {/* The leader fades as it falls, so the end that lands on a lit
                  limb is the faint end. One gradient covers both grounds where
                  a solid line needed an outline to survive either. */}
              <span
                aria-hidden
                className="mt-1 h-3.5 w-px"
                style={{
                  backgroundImage: `linear-gradient(to bottom, ${
                    selected
                      ? 'rgb(125 211 252 / 0.9)'
                      : 'rgb(226 232 240 / 0.6)'
                  }, transparent)`,
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/*
 * The canvas is the viewport in this app — `App` fills the window with it and
 * never scrolls — so the label layer's own box is the measurement, and reading
 * it from the window avoids a ResizeObserver whose only job would be to agree.
 */
const viewportSize = (): { width: number; height: number } => ({
  width: window.innerWidth,
  height: window.innerHeight,
})
