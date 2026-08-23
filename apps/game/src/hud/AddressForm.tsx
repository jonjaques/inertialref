import { Input } from '@/components/ui/input'
import { Action } from './Action.tsx'

/**
 * A ceiling on the address field.
 *
 * Not validation — the harness owns what an address means, and duplicating its
 * grammar here is how the two drift apart. It is a bound on what a paste can do
 * to the layout: the field's contents are echoed into the notice at the bottom
 * of the screen, and an unbounded one turns a transient message into a wall.
 */
const MAX_ADDRESS_LENGTH = 200

/**
 * Type an address, go there.
 *
 * shadcn/ui's `Input` rather than a bare `<input>`, so this field and the
 * catalogue's search field are the same control: they were two hand-written
 * boxes with different borders, different focus colours and different
 * placeholder grades, on two surfaces four files apart.
 */
export function AddressForm({
  query,
  onQuery,
  onSubmit,
}: {
  query: string
  onQuery: (query: string) => void
  onSubmit: () => void
}) {
  return (
    <form
      className="flex gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <Input
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="SOL · b:2 · g:milky-way/s:HIP71683/b:3.0"
        spellCheck={false}
        maxLength={MAX_ADDRESS_LENGTH}
        autoComplete="off"
        aria-label="Universe address"
        // 24 px tall on the dock's own ground, not the registry's 36 px
        // `bg-input/30` field. The ring is `--ring`, which `index.css` already
        // points at the same sky-400 hairline `FOCUS_RING` draws.
        className="type-readout h-7 min-w-0 flex-1 rounded border-slate-700 bg-slate-900/80 px-1.5 py-0.5 text-slate-200 shadow-none caret-sky-300 placeholder:text-slate-400 dark:bg-slate-900/80"
      />
      <Action label="Go" tone="primary" onClick={onSubmit} />
    </form>
  )
}
