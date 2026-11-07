import { useId } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { releaseFocus } from './focus.ts'

/*
 * A labeled on/off row.
 *
 * One definition for what used to be two: `GraphicsPanel` drew a bordered row
 * with the word `on`/`off` at the end, and the planetarium's view panel drew a
 * borderless one with an eye that opened and closed. They were the same
 * control, they disagreed about everything visible, and neither was a switch —
 * both were `<button aria-pressed>`, which a screen reader announces as a
 * toggle button rather than as something with an on state.
 *
 * Radix's `Switch` is the state; what it does not carry is that a *pointer*
 * click in this overlay has to hand focus back to the flight loop. See
 * `releaseFocus`, and `useShipControls`' `isOverlayControl` for why a
 * keyboard activation deliberately keeps it.
 *
 * The whole row is the target, through a real `<label htmlFor>`: at 10 px a
 * switch alone is a 32×18 hit box beside forty characters of text that look
 * exactly as clickable and were not. `min-h-9` — 36px — is what a two-line row
 * needs and is also comfortably past the 24px target minimum.
 *
 * The switch itself measures 24×14, under WCAG 2.2 SC 2.5.8's 24×24, and takes
 * the clause's **equivalent** exception: the row around it is a target for the
 * same function at the full panel width and 36px of height.
 *
 * The name is the label and only the label. A `<label>` names its control with
 * all of its text, so through `htmlFor` alone the switch is called the label
 * and the detail run together — a sentence for a name, read before the state.
 * `aria-labelledby` points at the word, and the sentence is the description,
 * which a reader announces after the name and the state.
 */

export function SwitchRow({
  label,
  detail,
  icon: Icon,
  on,
  onChange,
  divided = false,
  changed = false,
  disabled = false,
  title,
}: {
  label: string
  /** The half that explains it. Truncates — it is the expendable one. */
  detail?: string
  icon?: LucideIcon
  on: boolean
  onChange: (on: boolean) => void
  /**
   * A row in a list of settings: a hairline under it rather than a frame
   * around it, in the same geometry as `SettingRow`, so a switch and an option
   * group on one page put their controls in one column.
   */
  divided?: boolean
  /** Differs from its default — the gutter mark `SettingRow` draws. */
  changed?: boolean
  /**
   * Shown, dimmed, and not operable.
   *
   * For a switch whose *state* is still worth reading when the thing that sets
   * it is elsewhere — free look while standing, where a drag always turns the
   * head. Hiding it instead would make the row appear and disappear as the
   * camera descends, which reads as a fault rather than as a mode.
   */
  disabled?: boolean
  /** Overrides `detail` as the tooltip, for a row that carries a key. */
  title?: string
}) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      title={title ?? detail}
      className={`relative flex min-h-9 items-center gap-2.5 transition-colors ${
        disabled ? 'cursor-default opacity-45' : 'cursor-pointer'
      } ${
        divided
          ? 'border-b border-slate-800/70 py-2.5 pl-2.5 last:border-b-0'
          : 'rounded px-1 py-1.5 hover:text-slate-200'
      }`}
    >
      {divided && changed && (
        <span
          aria-hidden
          title="Changed from the default"
          className="absolute top-3 bottom-3 left-0 w-0.5 rounded-full bg-sky-400/80"
        />
      )}
      {Icon !== undefined && (
        <Icon
          aria-hidden
          className={`size-3.5 shrink-0 ${on ? 'text-sky-300' : 'text-slate-400'}`}
        />
      )}
      {/*
       * The detail sits *under* the label rather than beside it.
       *
       * Beside it, the two shared one line in a 19rem panel and the detail was
       * the half that truncated — so what a reader actually saw was
       * "Show the Ship  the hull the …", a label followed by three words of a
       * sentence that stopped mid-article. A fragment is worse than an
       * omission: it reads as a rendering fault rather than as a hint.
       *
       * Two lines cost about 14px in a panel that scrolls, and they let the
       * detail be a *sentence*. It still truncates on a very long one, but now
       * at the end of a clause rather than four words in.
       */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          id={`${id}-label`}
          className={`type-ui ${on ? 'text-sky-200' : divided ? 'text-slate-200' : 'text-slate-300'}`}
        >
          {label}
          {divided && changed && <span className="sr-only"> (changed)</span>}
        </span>
        {detail !== undefined && (
          // Sans and wrapping, not the panel's inherited mono and not
          // truncated. It is a sentence — the Correspondence register — and a
          // sentence set in the Instrument face is the "monospace as a costume
          // for technical" reflex. Two lines in a 19rem column is the honest
          // cost of saying the whole thing.
          <span
            id={`${id}-detail`}
            className="type-ui text-pretty text-slate-400"
          >
            {detail}
          </span>
        )}
      </span>
      <Switch
        id={id}
        aria-labelledby={`${id}-label`}
        aria-describedby={detail === undefined ? undefined : `${id}-detail`}
        size="sm"
        checked={on}
        disabled={disabled}
        onCheckedChange={onChange}
        onClick={releaseFocus}
        className="shrink-0"
      />
    </label>
  )
}
