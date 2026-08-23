import type { CSSProperties, ReactNode, Ref } from 'react'
import { ChevronDown, ChevronRight, Pin, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorBoundary } from '../hud/ErrorBoundary.tsx'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import type { DockPanelDefinition } from './panels.ts'

/*
 * A panel's frame: the surface, the header, and the four things a header does.
 *
 * One component for both arrangements, because a docked panel and a floating
 * one differ in exactly two ways — where they are, and which way the
 * float/dock toggle points — and everything else about them has to stay
 * identical. Two components was the first version and they drifted within a
 * day: the floating one grew a second close button and lost the collapse.
 *
 * The header is the drag handle *and* the collapse toggle, which is what every
 * editor with a docking system converged on and is worth stating because it
 * looks like a conflict. It is not: a press that does not move is a click, a
 * press that moves is a drag, and the browser resolves which happened before
 * either handler runs. What it buys is a header with two controls in it rather
 * than four — at 19rem, four 20px buttons and a title is a title with no room
 * left to be read.
 *
 * **A pin, and no hover cards.** The float control used to be a
 * picture-in-picture glyph, which names a *mechanism* nobody outside a docking
 * library has a word for; a pin names a state everybody already has one for,
 * and it can say which state it is in by lying down. Upright and lit is docked;
 * tipped over is loose. With the icons carrying the state, the two tooltips
 * that used to hang off this header were three popovers appearing over a
 * running scene every time a hand crossed a panel it was only trying to drag,
 * to say what a pin and an × already said. `aria-label` still names all three,
 * which is the half that was ever load-bearing.
 */

export interface PanelChromeProps {
  readonly definition: DockPanelDefinition
  readonly collapsed: boolean
  readonly floating: boolean
  readonly dragging: boolean
  /** The drag connector, on the header. The preview connector is on the root. */
  readonly handleRef: Ref<HTMLElement>
  readonly rootRef: Ref<HTMLElement>
  readonly onCollapse: () => void
  readonly onFloat: () => void
  readonly onDock: () => void
  readonly onHide: () => void
  /** Position and sizing, which is the caller's business rather than this one's. */
  readonly className?: string
  readonly style?: CSSProperties
  readonly children?: ReactNode
}

export function PanelChrome({
  definition,
  collapsed,
  floating,
  dragging,
  handleRef,
  rootRef,
  onCollapse,
  onFloat,
  onDock,
  onHide,
  className = '',
  style,
  children,
}: PanelChromeProps) {
  const Icon = definition.icon
  const Chevron = collapsed ? ChevronRight : ChevronDown

  return (
    <section
      data-dock-panel={definition.id}
      data-floating={floating ? '' : undefined}
      ref={rootRef}
      style={style}
      className={[
        'flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg bg-slate-950/85 backdrop-blur',
        'type-readout text-slate-300',
        /*
         * The one second elevation step in the system, and it earns it.
         *
         * A floating panel is over the scene with nothing beside it to be read
         * against, where a docked one sits in a pane among its neighbors. The
         * accent hairline says which of the two this is at a glance — it is the
         * same information the pin icon carries, in the peripheral vision that
         * actually notices a panel has come loose.
         */
        floating
          ? 'border border-sky-500/30 shadow-2xl shadow-black/60'
          : 'border border-slate-700/60 shadow-xl',
        // 40% rather than hidden: a panel that vanishes while dragged takes the
        // stack's layout with it, so every other panel jumps and the drop
        // indicator is measured against positions that no longer exist.
        dragging ? 'opacity-40' : '',
        className,
      ].join(' ')}
    >
      <header
        ref={handleRef}
        className={`flex min-h-8 cursor-grab items-center gap-1 border-slate-800 pr-1 pl-1.5 select-none active:cursor-grabbing ${
          collapsed ? '' : 'border-b'
        }`}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={(event) => {
            releaseFocus(event)
            onCollapse()
          }}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${definition.title}`}
          className={`flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 text-left transition-colors hover:text-sky-200 ${FOCUS_RING}`}
        >
          <Chevron aria-hidden className="size-3 shrink-0 text-slate-400" />
          <Icon aria-hidden className="size-3.5 shrink-0 text-sky-400/70" />
          {/*
           * The panel's name in the neutral ramp, one step brighter and one step
           * larger than the `sky-400/80` headings inside it. Two levels of
           * structure and they read in the right order: a title says what you
           * are looking at, a heading organizes what is in it, and the title
           * being the *quieter* color of the two was the thing that made every
           * panel look like five equally important shouts.
           */}
          <h2 className="type-heading truncate text-slate-200">
            {definition.title}
          </h2>
        </button>

        {/*
         * One glyph, two states, and the rotation is the state.
         *
         * `aria-pressed` rather than a label that changes verb, because that is
         * what this is: a pin that is either in or out. Upright and lit is
         * pinned into a pane; tipped to 45° is loose over the scene. That is the
         * convention every editor with a pinnable panel uses, and it survives
         * being 14 px on a dark surface where a slash through the pin —
         * lucide's `PinOff` — reads as "disabled" rather than "unpinned".
         *
         * And it tips *on hover*, to the state pressing it would produce. A
         * state icon and an action icon are the two readings anybody has of a
         * toggle, and this is the cheap way to be both: at rest it answers
         * "what is this panel", under the pointer it answers "what happens if I
         * press". It is also where the tooltip's sentence went when the header's
         * hover cards were removed.
         */}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-pressed={!floating}
          aria-label={`${definition.title}: ${floating ? 'pin back into its pane' : 'unpin, and float over the scene'}`}
          onClick={(event) => {
            releaseFocus(event)
            if (floating) onDock()
            else onFloat()
          }}
          className={`group shrink-0 rounded hover:bg-transparent hover:text-sky-200 ${FOCUS_RING} ${
            floating ? 'text-slate-400' : 'text-sky-300/80'
          }`}
        >
          <Pin
            className={`transition-transform duration-150 ${
              floating
                ? 'rotate-45 group-hover:rotate-0'
                : 'group-hover:rotate-45'
            }`}
          />
        </Button>

        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Close ${definition.title}`}
          onClick={(event) => {
            releaseFocus(event)
            onHide()
          }}
          className={`shrink-0 rounded text-slate-400 hover:bg-transparent hover:text-sky-200 ${FOCUS_RING}`}
        >
          <X />
        </Button>
      </header>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {/*
           * The boundary is here, in the one chrome both arrangements share,
           * so a throw in a body costs the body and not the mode. Without it
           * the throw unwinds to `App`'s mode-level boundary and takes the
           * panes, the menu — including the close control for the very panel
           * that failed — and, in the cinema, the playing scene down with it;
           * and since the panel is persisted open, the remount re-throws.
           */}
          <ErrorBoundary what={`the ${definition.title} panel`}>
            {children}
          </ErrorBoundary>
        </div>
      )}
    </section>
  )
}
