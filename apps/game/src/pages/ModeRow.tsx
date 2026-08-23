import type { ModeCard } from './modes.ts'
import { StatusBadge } from './StatusBadge.tsx'

/**
 * A mode this build does not offer a way into.
 *
 * Visible, and that is the point — `DESIGN.md` keeps a disabled control on
 * screen because its presence is information, and "there is a flight simulator
 * in here" is information a visitor deciding whether this is worth their
 * evening should have. What it is not is a *door*, so it is not shaped like
 * one: no card, no arrow, no hover, and the name in the prose sans rather than in
 * the display face the two open modes get.
 *
 * Not a `<button disabled>` either. There is nothing here to press — a disabled
 * control implies a state in which it would work, and the state that would
 * enable this one is a different build.
 *
 * **No blurb.** It had one, and dropping it is the design rather than a cut for
 * space. A blurb is a door's sales pitch; on a row that is not a door it was
 * three lines of prose set in the *instrument* face — monospace standing in for
 * "technical" — competing with the two modes a visitor can actually enter. The
 * glyph, the name and the status word answer the only question this block
 * exists to answer, which is what is here and why it is not open.
 */
export function ModeRow({ mode }: { mode: ModeCard }) {
  const Icon = mode.icon
  return (
    <div className="flex items-center gap-2.5">
      <Icon
        aria-hidden
        className="size-3.5 shrink-0 text-slate-500"
        strokeWidth={1.5}
      />
      {/*
       * `slate-300` and `slate-400`, not the `slate-500` a demoted row wants to
       * be: this system's ink floor is 400 and it is a measurement rather than a
       * preference — 500 reaches 4.24:1 on an opaque `slate-950` and no ground
       * here is more opaque than that. The demotion is carried by size, by the
       * prose sans instead of the display face, and by the absence of a card;
       * none of it is carried by contrast.
       */}
      <span className="type-ui text-slate-300">{mode.title}</span>
      <StatusBadge status={mode.status} />
    </div>
  )
}
