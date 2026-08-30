import { OverlayLink } from './OverlayLink.tsx'
import { FOCUS_RING } from '../hud/focus.ts'
import { KeySheet } from '../input/KeySheet.tsx'
import { LIVE_SETS } from '../input/keymap.ts'
import { OverlayPage } from './OverlayPage.tsx'
import { settingsSection } from './paths.ts'

/**
 * Every key, from any mode.
 *
 * `?` opens it, and the whole sheet is derived from `ACTIONS` — so it says what
 * the keys *are* rather than what they shipped as, which is the only kind of
 * help a rebindable build can have. A table of prose could not: it would name
 * the keys as string literals, and a literal is a key the editor cannot move.
 *
 * Every context at once rather than only the live one, and that is the choice
 * worth stating: the question somebody presses `?` to ask is usually "what can
 * I do here", but the question they ask *next* is "what could I do somewhere
 * else", and a sheet that hid the flight axes while the planetarium was on
 * screen would answer the first and refuse the second. The context is named on
 * each run, so what applies right now is still legible.
 */
export function KeysPage() {
  return (
    <OverlayPage title="Keys" subtitle="Every binding this build has">
      <KeySheet contexts={ALL_CONTEXTS} columns={2} />
      <p className="mt-3 border-t border-slate-800 pt-2 text-pretty text-slate-400">
        A chord is the physical key, so a binding survives a change of keyboard
        layout.{' '}
        <OverlayLink
          to={settingsSection('controls')}
          className={`text-sky-300/80 transition-colors hover:text-sky-200 ${FOCUS_RING}`}
        >
          Rebind them
        </OverlayLink>{' '}
        in Settings.
      </p>
    </OverlayPage>
  )
}

/**
 * Every context, deduplicated, in the order the live sets name them.
 *
 * Derived rather than written out, because a context added to the table and
 * forgotten here is a run of bindings the sheet silently does not mention —
 * which is exactly the drift the two prose tables had.
 */
const ALL_CONTEXTS = [...new Set(LIVE_SETS.flat())]
