/*
 * What is drawn, and who is allowed to say so.
 *
 * Four presentation fields — `showShip`, `showOrbits`, `flareArtifacts`, and
 * the observatory's target — were written on mode entry under three different
 * disciplines, none of them owned:
 *
 *   - the menu captured the previous values and restored them
 *   - the planetarium restored to hard-coded literals, so leaving it after
 *     arriving from the menu restored `showShip` to `true`, a value it never
 *     had — a live inconsistency, not a hypothetical one
 *   - flight set and never restored, its own comment calling it "belt and
 *     braces"
 *
 * `GameEngine` named the convention — "restored by whoever lowered it" — and
 * assigned it to nobody. `observatory.clear()` had three callers whose
 * correctness depended on unmount ordering, and `showShip` had three writers,
 * one of them a panel.
 *
 * ## Designed twice
 *
 * **A mode-to-stance table** was the other candidate, and it is the tidier one
 * on paper: the current mode is already derived from the URL, so a table read
 * by the frame loop eliminates restore entirely — leaving a mode *is* the next
 * mode's stance applying, which fits ADR-0011's "the mode is never held in
 * state" more tightly than anything here does.
 *
 * The deciding constraint is `NavPanel`'s in-planetarium ship toggle: a user
 * override on top of the mode's stance. The table needs a second channel for
 * it — and then a rule for what happens to that channel when the mode changes,
 * which is a restore rule wearing a different hat. **A stack gets it free**:
 * the toggle is just another push, and `release()` means "whatever was under
 * me", so the menu → planetarium → flight round trip lands where it started
 * without any layer having to remember what it displaced. That is the bug
 * class, and a stack makes it unrepresentable rather than commented against.
 *
 * The cost is that a layer must be released, and a mode that forgets holds the
 * scene hostage. That is a `useEffect` cleanup, which React already guarantees,
 * and it is the same discipline the three modes were already failing at less
 * safely.
 *
 * ## The guardrail
 *
 * **No fourth camera producer.** The camera order is ADR-0011's — cutscene,
 * then observatory, then the ship — and this changes none of it. What it owns
 * of the observatory is the target's *lifetime*: which layer put one there, so
 * that leaving that layer takes it away. Where the camera goes once there is a
 * target is `GameEngine.#step`'s, exactly as before.
 */

/** What a layer asks to be drawn. Anything omitted is left to the layer below. */
export interface Stance {
  /** The debug ship and the meter-scale reference props. */
  readonly showShip?: boolean
  /** Orbit traces. */
  readonly showOrbits?: boolean
  /** How much of the lens's artifact stack is showing, 0..1. */
  readonly flareArtifacts?: number
  /**
   * Whether this layer is holding the observatory's camera.
   *
   * `false` means "release it on the way out"; omitted means "not my business",
   * which is what a panel's override wants. It is a claim on the *target's
   * lifetime*, not on the camera — see the guardrail above.
   */
  readonly observatory?: boolean
}

/** What is actually drawn, once every layer has had its say. */
export interface Presentation {
  readonly showShip: boolean
  readonly showOrbits: boolean
  readonly flareArtifacts: number
  readonly observatory: boolean
}

/** The stance with nothing pushed: a flight camera on a visible ship. */
export const GROUND_STANCE: Presentation = {
  showShip: true,
  showOrbits: false,
  flareArtifacts: 1,
  observatory: false,
}

/** A pushed layer, until it is released. */
export interface StanceHandle {
  /** Restore whatever was underneath. Idempotent. */
  release(): void
  /** Change what this layer asks for, without disturbing the ones below. */
  update(stance: Stance): void
}

export interface PresentationStack {
  /** Push a layer. Modes push on mount and release on unmount. */
  push(stance: Stance): StanceHandle
  /** What every layer, resolved bottom to top, adds up to. */
  resolved(): Presentation
  /** How many layers are held. For the harness readout and the tests. */
  depth(): number
}

/**
 * Resolve a stack of stances, bottom to top.
 *
 * Last writer wins per field, which is what makes an override a push rather
 * than a special case: `NavPanel` pushes `{ showShip: false }` over the
 * planetarium's stance and neither of them has to know about the other.
 */
export function resolveStances(layers: readonly Stance[]): Presentation {
  let resolved = GROUND_STANCE
  for (const layer of layers) {
    resolved = {
      showShip: layer.showShip ?? resolved.showShip,
      showOrbits: layer.showOrbits ?? resolved.showOrbits,
      flareArtifacts: layer.flareArtifacts ?? resolved.flareArtifacts,
      observatory: layer.observatory ?? resolved.observatory,
    }
  }
  return resolved
}

export function createPresentationStack(
  /**
   * Called whenever the resolved stance changes.
   *
   * The stack is pure; applying the answer is the engine's. That split is what
   * lets the whole round trip — menu, planetarium, flight, back — be a Node
   * test with no React, no renderer and no world.
   */
  onChange: (presentation: Presentation) => void,
): PresentationStack {
  /** Boxes, so `update` can replace a layer's contents without moving it. */
  const layers: { stance: Stance }[] = []
  let last = GROUND_STANCE

  const settle = (): void => {
    const next = resolveStances(layers.map((one) => one.stance))
    if (
      next.showShip === last.showShip &&
      next.showOrbits === last.showOrbits &&
      next.flareArtifacts === last.flareArtifacts &&
      next.observatory === last.observatory
    ) {
      return
    }
    last = next
    onChange(next)
  }

  return {
    push(stance) {
      const layer = { stance: { ...stance } }
      layers.push(layer)
      settle()
      return {
        release() {
          const at = layers.indexOf(layer)
          // Idempotent, and by identity rather than by position: React may
          // release a layer after another mount has already pushed over it, and
          // popping the top would take somebody else's.
          if (at === -1) return
          layers.splice(at, 1)
          settle()
        },
        update(next) {
          // The box keeps its place in the stack, so a layer that changes what
          // it asks for does not become the top one.
          if (!layers.includes(layer)) return
          layer.stance = { ...next }
          settle()
        },
      }
    },
    resolved: () => last,
    depth: () => layers.length,
  }
}
