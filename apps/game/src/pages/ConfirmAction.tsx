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
        {asking ? question : ''}
      </span>
      {asking ? (
        <>
          <span aria-hidden className="type-ui text-slate-300">
            {question}
          </span>
          <Action
            id={`${id}-act`}
            label={act}
            tone="primary"
            title={actTitle}
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
