import { useEffect, useRef, useState } from 'react'
import { Workspace } from '../dock/Workspace.tsx'
import type { DevWorkspace } from '../dock/workspace.ts'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useOverlayStore } from '../pages/overlay.ts'
import { DocsBar } from './DocsBar.tsx'
import { DocsHorizon } from './DocsHorizon.tsx'
import { DocsMasthead } from './DocsMasthead.tsx'
import { DocsRail } from './DocsRail.tsx'
import { DocArticle } from './DocArticle.tsx'
import { DocContents } from './DocContents.tsx'
import { wingFor } from './docsNav.ts'
import { useDocsFraming } from './useDocsFraming.ts'
import { useManifest, usePage } from './useDocs.ts'

/*
 * The reading room.
 *
 * A mode, like the planetarium and the player — the same engine, the same
 * canvas, the same shell — with a layout that is doing something no other mode
 * here does: it **scrolls**. The application is `overflow: hidden` on `html`,
 * `body` and `#root`, because the HUD is absolutely positioned over a canvas
 * and a document that scrolled would move the canvas out from under it. So this
 * scrolls inside its own box, which is the only kind of scrolling the interface
 * has and exactly what `index.css` says every long panel does.
 *
 * ## The composition, and the one idea it owns
 *
 * **The sky is the masthead, and a strip of it never leaves.**
 *
 *     ┌────────────────────────────────────────────┐
 *     │  live scene · what is in frame, as a readout│  the horizon, 3 rem,
 *     ├────────────────────────────────────────────┤  outside the scroller
 *     │                                            │
 *     │  live scene · the wing's name, its blurb   │  the masthead, scrolls away
 *     │                                            │
 *     ├────────────────────────────────────────────┤
 *     │ breadcrumb · search · source               │  the bar, sticky
 *     ├──────────┬──────────────────┬──────────────┤
 *     │ the wing │  the document    │ on this page │  the plate
 *
 * The horizon is a permanent three-rem window onto the running simulation at
 * the top of every page in the section, and it is not decoration: it is the
 * reason a documentation site for this project should be *inside* the
 * application rather than beside it. What the camera is looking at is stated
 * beside it in the Instrument register, so the picture is a readout rather than
 * a texture — and it changes per wing, so moving from the concepts to the
 * design bible is a flight from Saturn to Mars behind the words.
 *
 * Everything below the masthead is a near-opaque plate. That is a contrast
 * decision rather than an aesthetic one: this is the one surface in the product
 * somebody reads a thousand words on, and `DESIGN.md`'s Legibility-Over-Glass
 * Rule says alpha loses every argument against contrast. The plate is
 * `slate-950/92` over a blur, which measures above 9:1 for body text with a
 * star filling the frame behind it — the standing test — and still lets the
 * scene move faintly behind the margins.
 */

export function DocsMode({
  engine,
  dev,
}: {
  engine: GameEngine
  dev: DevWorkspace
}) {
  /*
   * The mode's own location, not the address bar's. With a dialog open over
   * the reading room the two differ, and this component reads the overlay
   * store's `mode` — reading the address bar here would refetch the page
   * for `/settings` and find nothing.
   *
   * The **hash** comes from the same place: a dialog's URL carries no
   * fragment, so reading it raw turns opening Settings from
   * `/docs/concepts/frames#the-chain` into a `hash` that changed to `''`,
   * which re-runs the scroll below and throws the reading room back to the
   * top behind the scrim.
   */
  const route = normalize(useOverlayStore((state) => state.mode.pathname))
  const hash = useOverlayStore((state) => state.mode.hash)

  const manifest = useManifest()
  const wing =
    manifest.value === null ? undefined : wingFor(manifest.value, route)
  const page = usePage(manifest.value, route)
  const framed = useDocsFraming(engine, wing?.framing)

  const room = useRef<HTMLDivElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const plate = useRef<HTMLDivElement | null>(null)
  const [railOpen, setRailOpen] = useState(false)

  /*
   * Opening the contents brings the page to them.
   *
   * Below 1024 the rail is a drawer in flow at the top of the plate, which is
   * the only way to draw it without positioning chrome against the viewport —
   * and the consequence is that a reader four screens into a document opens
   * something that is four screens above them. Scrolling the plate's top under
   * the bar puts the drawer exactly where the button that opened it is. On a
   * wide screen the rail is always visible and this scrolls nothing that was
   * not already at the top.
   */
  const toggleRail = (): void => {
    const opening = !railOpen
    setRailOpen(opening)
    if (!opening) return
    const box = scroller.current
    const surface = plate.current
    if (box !== null && surface !== null) box.scrollTop = surface.offsetTop
  }

  /*
   * How tall the reading area is, published as `--doc-view`.
   *
   * The rail and the table of contents are sticky columns that can be taller
   * than the screen, and a sticky element with no ceiling pins at its top and
   * runs off the bottom with no way to reach the rest of it. The ceiling is
   * this measurement, and it is a measurement rather than `100dvh` because
   * AGENTS.md is explicit that no chrome in this application sizes itself
   * against the viewport: the layer this is drawn in has already spent the
   * safe-area insets, and a viewport unit would spend them again.
   *
   * On the element itself rather than on `:root`, so nothing outside the
   * reading room can read a variable that only describes it.
   */
  useEffect(() => {
    const element = room.current
    if (element === null) return
    const observer = new ResizeObserver(([entry]) => {
      const height = entry?.contentRect.height
      if (height !== undefined)
        element.style.setProperty('--doc-view', `${Math.round(height)}px`)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /*
   * Where a navigation lands.
   *
   * The top of the document for a new page, and the named section when the link
   * carried one. Both have to be written down, because neither is free: the
   * browser restores the *document's* scroll position and this document never
   * scrolls, and a fragment link into a container the browser did not scroll to
   * is a click that appears to do nothing.
   *
   * On `page.value` rather than on `route`, so the scroll happens after the
   * body it is scrolling through exists. Anchored a beat under the sticky bar
   * by `scroll-margin-top` in `index.css`, so a heading never lands beneath it.
   */
  useEffect(() => {
    const box = scroller.current
    if (box === null || page.value === null) return
    if (hash.length > 1) {
      const target = box.querySelector(`#${CSS.escape(hash.slice(1))}`)
      if (target !== null) {
        target.scrollIntoView({ block: 'start' })
        return
      }
    }
    box.scrollTop = 0
  }, [page.value, hash])

  // A route change closes the rail's sheet: on a phone the rail *is* the way
  // to a page, so leaving it up over the page it just opened hides the answer.
  useEffect(() => setRailOpen(false), [route])

  return (
    <>
      <div
        ref={room}
        className="doc-room pointer-events-auto absolute inset-0 flex flex-col"
      >
        <DocsHorizon framed={framed} />
        <div
          ref={scroller}
          className="doc-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <DocsMasthead
            wing={wing}
            page={page.value}
            route={route}
            counts={manifest.value?.counts ?? null}
            pending={manifest.pending || page.pending}
          />
          <DocsBar
            manifest={manifest.value}
            route={route}
            page={page.value}
            railOpen={railOpen}
            onRail={toggleRail}
          />
          <div ref={plate} className="doc-plate">
            <div className="doc-grid">
              <DocsRail
                manifest={manifest.value}
                route={route}
                open={railOpen}
                onClose={() => setRailOpen(false)}
              />
              <DocArticle
                manifest={manifest.value}
                route={route}
                page={page}
                error={manifest.error}
              />
              <DocContents page={page.value} />
            </div>
          </div>
        </div>
      </div>
      {/*
       * The IR menu, over the reading room, exactly as it is over the cinema
       * library — the mark, the way back to the front door and the settings.
       * Without it the documentation is the one place in the build with no exit
       * that is not the browser's back button.
       *
       * The article's last line clears it: `.doc-article` carries the padding,
       * because the menu is drawn by a sibling and cannot push anything.
       */}
      <Workspace id="docs" title="Documentation" panels={NO_PANELS} dev={dev} />
    </>
  )
}

/** Docs contributes no panels of its own. Named, so the array is stable. */
const NO_PANELS = [] as const

/** `/docs/` and `/docs` are one page, so they get one spelling. */
const normalize = (pathname: string): string =>
  pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
