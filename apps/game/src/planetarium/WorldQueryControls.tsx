import type { BodyKind, SpectralClass, WorldQuery } from '@inertialref/universe'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import {
  SEARCH_RADII,
  STAR_CLASSES,
  WORLD_FLAGS,
  WORLD_KINDS,
} from './worldQuery.ts'

/**
 * What the volume is being asked for.
 *
 * Three rows and a radius, and the shape of each is chosen by how many answers
 * its question has. Classes and kinds are multi-select chips, because "G or K"
 * is a question people ask. The five yes/no clauses are **three-state**, and
 * that is the one non-obvious decision here: a plain switch cannot say the
 * difference between "I do not care whether it has air" and "I want the ones
 * with none", and both are searches somebody runs — the airless worlds are
 * where the sharp horizons are. Off is the absent clause, and the two lit
 * states are the two answers.
 */
export function WorldQueryControls({
  query,
  radius,
  onQuery,
  onRadius,
}: {
  readonly query: WorldQuery
  readonly radius: string
  readonly onQuery: (next: WorldQuery) => void
  readonly onRadius: (next: string) => void
}) {
  const flagValue = (id: (typeof WORLD_FLAGS)[number]['id']): string => {
    const held = query[id]
    return held === undefined ? '' : held ? 'yes' : 'no'
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="type-label text-sky-400/80">
          Around stars of class
        </span>
        <ToggleGroup
          type="multiple"
          size="sm"
          variant="outline"
          spacing={1}
          value={[...(query.starClasses ?? [])]}
          aria-label="Star classes"
          onValueChange={(next) =>
            onQuery({ ...query, starClasses: next as SpectralClass[] })
          }
          className="flex-wrap"
        >
          {STAR_CLASSES.map((one) => (
            <ToggleGroupItem
              key={one.id}
              value={one.id}
              onClick={releaseFocus}
              title={one.detail}
              className={`type-readout h-7 min-w-8 rounded border-slate-700 px-2 data-[state=off]:text-slate-400 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200 ${FOCUS_RING}`}
            >
              {one.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {/* The sequence, said once, because O B A F G K M is the one ordering
            a reader of a star chart already knows and the chips are otherwise
            seven unlabelled letters. */}
        <p className="type-micro text-slate-400">
          Hottest to coolest. Empty means any.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="type-label text-sky-400/80">Body</span>
        <ToggleGroup
          type="multiple"
          size="sm"
          variant="outline"
          spacing={1}
          value={[...(query.kinds ?? [])]}
          aria-label="Body classes"
          onValueChange={(next) =>
            onQuery({ ...query, kinds: next as BodyKind[] })
          }
          className="flex-wrap"
        >
          {WORLD_KINDS.map((one) => (
            <ToggleGroupItem
              key={one.id}
              value={one.id}
              onClick={releaseFocus}
              className={`type-label h-7 rounded border-slate-700 px-2 data-[state=off]:text-slate-400 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200 ${FOCUS_RING}`}
            >
              {one.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="type-label text-sky-400/80">Must have</span>
        {WORLD_FLAGS.map((flag) => (
          <div
            key={flag.id}
            className="flex items-center justify-between gap-3"
          >
            <span className="min-w-0">
              <span className="type-ui block truncate text-slate-300">
                {flag.label}
              </span>
              <span className="type-micro block text-pretty text-slate-400">
                {flag.detail}
              </span>
            </span>
            {/*
             * `type="single"`, and the empty string is the third state: Radix
             * returns it when a pressed item is pressed again, which is exactly
             * "I have stopped asking". That is what makes the clause removable
             * without a third button labelled "any" taking a row's width to say
             * what the absence of a selection already says.
             */}
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={flagValue(flag.id)}
              aria-label={flag.label}
              onValueChange={(next) =>
                onQuery({
                  ...query,
                  [flag.id]: next === '' ? undefined : next === 'yes',
                })
              }
              className="shrink-0"
            >
              <ToggleGroupItem
                value="yes"
                onClick={releaseFocus}
                title={`Only bodies with ${flag.label.toLowerCase()}`}
                className={`type-label h-6 min-w-9 border-slate-700 px-1.5 data-[state=off]:text-slate-400 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200 ${FOCUS_RING}`}
              >
                Yes
              </ToggleGroupItem>
              <ToggleGroupItem
                value="no"
                onClick={releaseFocus}
                title={`Only bodies without ${flag.label.toLowerCase()}`}
                className={`type-label h-6 min-w-9 border-slate-700 px-1.5 data-[state=off]:text-slate-400 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200 ${FOCUS_RING}`}
              >
                No
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="type-label block text-sky-400/80">Within</span>
          {/* The cost, said before it is paid: every system in the radius is
              generated to be tested, and the reader is the one choosing how
              many that is. */}
          <span className="type-micro block text-pretty text-slate-400">
            Every system inside this is built to be tested.
          </span>
        </span>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={radius}
          aria-label="Search radius, light years"
          onValueChange={(next) => {
            if (next !== '') onRadius(next)
          }}
          className="shrink-0"
        >
          {SEARCH_RADII.map((option) => (
            <ToggleGroupItem
              key={option}
              value={option}
              onClick={releaseFocus}
              title={`Search everything within ${option} light years`}
              className={`type-label h-6 min-w-9 border-slate-700 px-1.5 data-[state=off]:text-slate-400 data-[state=on]:bg-sky-500/15 data-[state=on]:text-sky-200 ${FOCUS_RING}`}
            >
              {option}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </div>
  )
}
