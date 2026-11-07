import type { KeyboardEvent, Ref } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { FOCUS_RING, releaseFocus } from './focus.ts'

/**
 * A field that narrows a list: a glyph, the text, and a way to clear it.
 *
 * One component for the navigator, the key editor and the preset library,
 * because hand-written copies drift — the registry's `Input` sets its
 * placeholder at 16 px beside 11 px readouts, and a copy that forgets the
 * clear control or the glyph is a second kind of field — and a reader who has
 * learned one search field here should not have to learn the next.
 *
 * The frame is a `<label>`, so the glyph and the padding are part of the hit
 * area and focus is drawn on the frame (`focus-within`) rather than as a ring
 * inside it. `mono` sets the text in the instrument face, for the navigator,
 * whose field takes addresses; a field that takes words takes the sans.
 */
export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  mono = false,
  inputRef,
  onKeyDown,
  className = '',
}: {
  value: string
  onChange: (value: string) => void
  /** The field's name, for a screen reader and for speech input. */
  label: string
  placeholder: string
  mono?: boolean
  inputRef?: Ref<HTMLInputElement>
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  className?: string
}) {
  return (
    <label
      className={`flex h-8 min-w-0 items-center gap-1.5 rounded border border-slate-700/60 bg-slate-900/60 px-2 transition-colors focus-within:border-sky-500/60 ${className}`}
    >
      <Search aria-hidden className="size-3.5 shrink-0 text-slate-400" />
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        // The step twice, bare and at `md:`: the Input base carries
        // `md:text-sm`, which only merges against an equally modified class.
        // `lib/utils.ts` has the whole story.
        className={`${mono ? 'type-readout md:type-readout' : 'type-ui md:type-ui'} h-full border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent`}
      />
      {value !== '' && (
        <button
          type="button"
          aria-label="Clear the search"
          onClick={(event) => {
            releaseFocus(event)
            onChange('')
          }}
          className={`-mr-1 flex size-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:text-sky-200 ${FOCUS_RING}`}
        >
          <X aria-hidden className="size-3" />
        </button>
      )}
    </label>
  )
}
