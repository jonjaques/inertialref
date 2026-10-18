import { FOCUS_RING } from '../hud/focus.ts'
import { focusWayHome, useWayHome, WAY_HOME } from './wayHome.ts'

/*
 * The first tab stop in the document: straight to the menu.
 *
 * The IR menu is the last thing in the workspace's DOM, after the float field
 * and both panes, so the way home and the way to Settings sit behind every
 * open panel's controls — stop 133 of 148 on `/planetarium` at 1600×900 in the
 * shell review's census. This link is in front of all of it, and activating it
 * puts focus on the menu's first control, the mark that links home.
 *
 * A skip link rather than the menu moved earlier in the DOM. The menu has no
 * z-index, so its place in the DOM is also its place in paint and hit testing
 * against the panes, and DOM order is the arbitration the workspace rests on
 * (`Workspace.tsx`, the float field before the panes). Reordering it to fix tab
 * order trades that for this. A skip link adds one stop and moves nothing, and
 * it is the bypass a screen-reader user already expects first (SC 2.4.1).
 *
 * Rendered by `Root` ahead of `GameLoader`, because `App`'s layer comes first
 * in the document and holds controls of its own — the walker's row — which a
 * link in `PageShell`'s layer would sit behind. It brings its own `.hud-layer`:
 * that is what tells flight input a key pressed here belongs to a control
 * (`isOverlayControl`), and what clamps the chip's backdrop blur to standard
 * range. `data-skip-link` keeps `hudLayer()` from portalling popups into a
 * layer that exists only while this link does.
 *
 * Invisible until it has focus, so a pointer never meets it, and it does not
 * call `releaseFocus`: moving focus is its whole job. A real `href`, so it is
 * announced as the link it is; the handler keeps the fragment out of the
 * address bar, because the URL is the public surface.
 */
export function SkipLink() {
  const present = useWayHome()
  if (!present) return null
  return (
    <div className="hud-layer pointer-events-none absolute" data-skip-link="">
      <a
        href={`#${WAY_HOME}`}
        onClick={(event) => {
          event.preventDefault()
          focusWayHome()
        }}
        className={`type-ui pointer-events-auto absolute top-3 left-3 z-50 flex min-h-6 items-center rounded border border-sky-500/50 bg-slate-950/90 px-2 py-0.5 text-sky-200 backdrop-blur not-focus:sr-only ${FOCUS_RING}`}
      >
        Skip to the workspace menu
      </a>
    </div>
  )
}
