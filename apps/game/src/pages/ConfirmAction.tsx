import { useId, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Action } from '../hud/Action.tsx'

/**
 * A destructive verb asked twice, in place.
 *
 * In place rather than through a dialog, because the settings page is already
 * one and a dialog over a dialog is a scrim over a scrim. The resting button
 * names the act; pressing it puts the question, the act and "Keep" where it
 * was, so the destructive word only appears once it has been asked for and
 * the resting state cannot be pressed by accident. Every page's restore and
 * the data page's reset go through this one control, so the question and its
 * two answers read the same wherever they are asked.
 *
 * **The button that was pressed goes away, so a keyboard is handed onward.**
 * The ask hands its focus to Keep — the answer that changes nothing — and both
 * answers hand it back to the ask, or, when the act has left nothing to ask
 * about and the ask is disabled, to the dialog itself. A pointer press hands
 * focus back to the flight loop as every control here does (`handFocus`). The
 * question is also said through a live region that stays mounted, because a
 * region created with its text already in it is one a screen reader may never
 * announce.
 */
export function ConfirmAction({
  label,
  icon,
  title,
  disabled = false,
  question,
  act,
  actTitle,
  onAct,
}: {
  /** The resting button's word. */
  label: string
  icon?: LucideIcon
  title: string
  disabled?: boolean
  /** What is asked once it has been pressed, as a question. */
  question: string
  /** The answer that does it. */
  act: string
  actTitle: string
  onAct: () => void
}) {
  const [asking, setAsking] = useState(false)
  /*
   * The question stands only while there is something to answer. A count can
   * reach zero under an open question — a row's own reset below it, a capture
   * that lands on its default, an import — and the question then read
   * "Restore 0 settings?" with its verb still armed. It is closed in the
   * render that sees it, React's own pattern for state that follows a prop,
   * rather than by an effect, so no frame draws both; and closed rather than
   * hidden, or a later change would bring the question back unasked.
   */
  if (asking && disabled) setAsking(false)
  const open = asking && !disabled
  const id = useId()
  const element = (part: string): HTMLButtonElement | null =>
    document.getElementById(`${id}-${part}`) as HTMLButtonElement | null
  /** The ask if it can take focus, and the dialog when it cannot. */
  const home = (): HTMLElement | null => {
    const ask = element('ask')
    if (ask !== null && !ask.disabled) return ask
    return document
      .getElementById(`${id}-region`)
      ?.closest('[role=dialog]') as HTMLElement | null
  }
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      <span id={`${id}-region`} aria-live="polite" className="sr-only">
        {open ? question : ''}
      </span>
      {open ? (
        <>
          {/* The answers are described by the question as well as announced
              with it: a polite announcement that coincides with the focus
              moving to Keep is one screen readers often drop, and Keep read
              without its question is a button with no meaning. */}
          <span id={`${id}-question`} className="type-ui text-slate-300">
            {question}
          </span>
          <Action
            id={`${id}-act`}
            label={act}
            tone="primary"
            title={actTitle}
            describedBy={`${id}-question`}
            then={home}
            onClick={() => {
              onAct()
              setAsking(false)
            }}
          />
          <Action
            id={`${id}-keep`}
            label="Keep"
            title="Leave everything as it is"
            describedBy={`${id}-question`}
            then={home}
            onClick={() => setAsking(false)}
          />
        </>
      ) : (
        <Action
          id={`${id}-ask`}
          label={label}
          icon={icon}
          title={title}
          disabled={disabled}
          then={() => element('keep')}
          onClick={() => setAsking(true)}
        />
      )}
    </span>
  )
}
