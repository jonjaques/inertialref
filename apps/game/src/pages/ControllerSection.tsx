import { useEffect, useRef, useState } from 'react'
import { OptionGroup } from '../hud/OptionGroup.tsx'
import { ControllerDiagram } from '../input/ControllerDiagram.tsx'
import type { Callout } from '../input/controllerLayout.ts'
import {
  calloutLabels,
  calloutOf,
  PAD_VIEWS,
  type PadView,
} from '../input/controllerLabels.ts'
import {
  findAction,
  padCollisions,
  resolvePadBindings,
} from '../input/keymap.ts'
import type { PadControl } from '../input/pad.ts'
import { familyName, padLabel } from '../input/padFamily.ts'
import { PadBindingList } from '../input/PadBindingList.tsx'
import { PadTuningSection } from '../input/PadTuningSection.tsx'
import { useInputDevice, useKeymap } from '../input/useKeymap.ts'
import { usePadLive } from '../input/usePadLive.ts'
import { Section } from '../hud/Section.tsx'
import { CONTROLS_PAD, usePersistentState } from '../state/preferences.ts'
import { defaultPad } from './settingsDefaults.ts'

/*
 * The controller: a picture of it, what each control does in each mode, and
 * how it feels.
 *
 * A page of its own beside the keyboard's, rather than a second column in the
 * keyboard editor, because the two answer different questions. A key is found
 * by its name and a list of names is the right picture of a keyboard; a pad
 * control is found by *where it is*, and the right picture of a pad is a pad.
 *
 * Bindings are overrides only, as for the keys, so a default that moves keeps
 * tracking for everybody who has not chosen otherwise.
 */

/**
 * How long a row listens before it gives up, in milliseconds.
 *
 * A pad has no Escape that is not also a bindable button, so a listening row
 * would otherwise hold every press on the pad until something else was
 * clicked — and on a pad there is nothing else to click with.
 */
const LISTEN_MS = 8000

const VIEW_LABELS = Object.fromEntries(
  PAD_VIEWS.map((view) => [view.id, view.title]),
)

export function ControllerSection() {
  const store = useKeymap()
  const { family, pads } = useInputDevice()
  const live = usePadLive()
  const [overrides, setOverrides] = usePersistentState(CONTROLS_PAD)
  const [view, setView] = useState<PadView>('flight')
  const [capturing, setCapturing] = useState<string | null>(null)
  const [hovered, setHovered] = useState<Callout | null>(null)
  const [said, setSaid] = useState<string | null>(null)

  const spec = PAD_VIEWS.find((one) => one.id === view) ?? PAD_VIEWS[0]
  const bindings = resolvePadBindings(overrides)
  const clashes = clashesIn(overrides)
  const shown = live?.family ?? family

  const assign = (id: string, control: PadControl): void => {
    // The act's own default is a return to it, not an override that copies
    // it — the keyboard editor's rule, for the keyboard editor's reasons.
    const home = control === defaultPad(id)
    setOverrides((held) =>
      home ? withoutOverride(held, id) : { ...held, [id]: control },
    )
    setCapturing(null)
    const action = findAction(id)
    const clash = clashesIn(
      home ? withoutOverride(overrides, id) : { ...overrides, [id]: control },
    ).get(id)
    setSaid(
      clash === undefined
        ? `${action?.label ?? id} is now ${padLabel(control, shown)}`
        : `${padLabel(control, shown)} also means ${clash}`,
    )
  }
  const assignLatest = useRef(assign)
  assignLatest.current = assign

  /*
   * The pad's half of a capture: the driver hands over the next fresh press
   * and nothing else until it does, and gives up after `LISTEN_MS`.
   */
  useEffect(() => {
    if (capturing === null) return
    const pad = store.pad
    pad?.capture((control) => assignLatest.current(capturing, control))
    const timer = window.setTimeout(() => setCapturing(null), LISTEN_MS)
    return () => {
      pad?.capture(null)
      window.clearTimeout(timer)
    }
  }, [store, capturing])

  const listeningTo = capturing === null ? null : bindings.get(capturing)
  const highlight =
    listeningTo === null || listeningTo === undefined
      ? hovered
      : calloutOf(listeningTo)

  return (
    <div className="@container flex flex-col gap-3">
      {/* Whether a pad is here, which is live and changes what the page is
          for: with one connected, a press on it rebinds; without, the browser
          has not shown it to the page yet. Restoring the defaults is the
          page header's, beside the other pages' own. */}
      <p className="type-ui text-pretty text-slate-300">
        {pads > 0 && live !== null
          ? `${familyName(live.family)} connected. Press a row’s control, then a control on the pad or on the picture.`
          : 'No controller yet. Browsers show one only after a button on it is pressed, so press any button.'}
      </p>

      <OptionGroup
        label="Mode"
        value={view}
        values={PAD_VIEWS.map((one) => one.id)}
        labels={VIEW_LABELS}
        onChange={(next) => {
          setView(next)
          setCapturing(null)
        }}
        className="flex-wrap self-start"
      />

      <ControllerDiagram
        family={shown}
        state={live}
        labels={calloutLabels(bindings, spec.live)}
        highlight={highlight}
        listening={capturing !== null}
        onPick={(control) => {
          if (capturing !== null) assign(capturing, control)
          else setHovered(calloutOf(control))
        }}
      />

      {/* Announced here as well as on the row, for the reason the keyboard
          editor gives: a result reported only in a label a screen reader has
          already read past is a result reported to nobody. */}
      <p aria-live="polite" className="type-ui min-h-4 text-sky-300/90">
        {said}
      </p>

      <PadBindingList
        contexts={spec.rows}
        bindings={bindings}
        overrides={overrides}
        family={shown}
        clashes={clashes}
        capturing={capturing}
        onCapture={(id) => {
          setCapturing(id)
          setSaid(
            id === null
              ? null
              : `Press a control for ${findAction(id)?.label ?? id}, on the pad or on the picture.`,
          )
        }}
        onUnbind={(id) => {
          setOverrides((held) =>
            defaultPad(id) === null
              ? withoutOverride(held, id)
              : { ...held, [id]: null },
          )
          setCapturing(null)
          setSaid(`${findAction(id)?.label ?? id} has no control`)
        }}
        onReset={(id) => setOverrides((held) => withoutOverride(held, id))}
        onHover={setHovered}
      />

      <Section id="settings.controller.feel" title="Feel">
        <PadTuningSection rumbles={pads > 0 && live?.vibration === true} />
      </Section>
    </div>
  )
}

/**
 * Which row shares a control with another of equal claim, by id, as the other
 * act's label. Ambiguities only — a shadow is the design (`padCollisions`).
 */
function clashesIn(
  overrides: Readonly<Record<string, string | null>>,
): ReadonlyMap<string, string> {
  const found = new Map<string, string>()
  for (const collision of padCollisions(resolvePadBindings(overrides))) {
    if (collision.kind !== 'ambiguous') continue
    for (const id of collision.ids) {
      const other = collision.ids.find((one) => one !== id)
      const label = other === undefined ? undefined : findAction(other)?.label
      if (label !== undefined && !found.has(id)) found.set(id, label)
    }
  }
  return found
}

/** A binding table without one act's override, which is "the default". */
function withoutOverride(
  held: Readonly<Record<string, string | null>>,
  id: string,
): Readonly<Record<string, string | null>> {
  const { [id]: _dropped, ...rest } = held
  return rest
}
