/*
 * What is drawn, and who is allowed to say so.
 *
 * Seven presentation fields — `showShip`, `showOrbits`, `orbitScope`, `labels`,
 * `flareArtifacts`, `chrome`, and the observatory's target. Four of the
 * original five were written on mode entry under three different disciplines,
 * none of them owned:
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
 * The deciding constraint is the in-planetarium ship toggle — `ViewPanel`'s
 * now — which is a user override on top of the mode's stance. The table needs a second channel for
 * it — and then a rule for what happens to that channel when the mode changes,
 * which is a restore rule wearing a different hat. **A stack gets it free**:
 * the toggle is just another push, and `release()` means "whatever was under
 * me", so the menu → planetarium → flight round trip lands where it started
 * without any layer having to remember what it displaced. That is the bug
 * class, and a stack makes it unrepresentable rather than commented against.
 *
 * `orbitScope` is the field that proves the shape: it arrived after the stack
 * existed, and it needed nothing — one more line in `resolveStances`, and the
 * View panel's switch is a push like any other.
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

/**
 * Which orbits are worth drawing.
 *
 * `context` is the subject's siblings and the things going round it — eight
 * ellipses that answer "where is this relative to the planets". `all` is every
 * orbit in every loaded system, which in Sol is a hundred and twenty-nine lines
 * with the subject somewhere behind them; it is the right answer exactly once,
 * when the question is the shape of the whole system rather than one body in
 * it. `docs/design/planetarium.md` § "Orbit traces" argues the default.
 */
export type OrbitScope = 'context' | 'all'

/** What a layer asks to be drawn. Anything omitted is left to the layer below. */
export interface Stance {
  /** Integrate image motion over the lens's shutter. */
  readonly motionBlur?: boolean
  /** The debug ship and the meter-scale reference props. */
  readonly showShip?: boolean
  /** Orbit traces. */
  readonly showOrbits?: boolean
  /**
   * Names on the sky.
   *
   * A stance rather than a prop threaded from the preference that sets it, and
   * the rule has no carve-out for the fields that look like preferences —
   * `orbitScope` is the precedent. What decided it here is the plate rig: a
   * thumbnail of a picture is a thumbnail of what the *camera* does, and the
   * layers are the viewer's, drawn over whatever it does. A capture has to be
   * able to say "not this time" without editing somebody's stored settings, and
   * a push is what that is.
   */
  readonly labels?: boolean
  /**
   * How many of them: the subject's own context, or every orbit in the system.
   *
   * A stance field rather than a panel's own boolean, because it is a
   * *presentation switch* and the rule about those has no carve-out for the
   * ones that look like preferences — a mode pushes it, a panel overrides it,
   * and `release()` puts back whatever was underneath. It is also read by the
   * frame loop, which is the other half of why it cannot live in React state.
   */
  readonly orbitScope?: OrbitScope
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
  /**
   * Whether the interface is in the frame at all.
   *
   * A presentation switch like the rest, and it is here rather than in React
   * state for the reason the others are: `Shift+H` is a viewer's override on
   * top of a mode's stance, `ir.chrome(false)` is a script's, and a plate is
   * defined as the frame taken with it false. A boolean in `App` could be
   * reached by the first of those and by neither of the others.
   *
   * What it clears is chrome — panes, menu, reticle, flight strip, notices. The
   * sky labels are content and stay, which is why this is not the gate a
   * cutscene uses: that one unmounts the mode outright.
   */
  readonly chrome?: boolean
}

/** What is actually drawn, once every layer has had its say. */
export interface Presentation {
  readonly motionBlur: boolean
  readonly showShip: boolean
  readonly showOrbits: boolean
  readonly labels: boolean
  readonly orbitScope: OrbitScope
  readonly flareArtifacts: number
  readonly observatory: boolean
  readonly chrome: boolean
}

/** The stance with nothing pushed: a flight camera on a visible ship. */
export const GROUND_STANCE: Presentation = {
  motionBlur: true,
  showShip: true,
  showOrbits: false,
  labels: true,
  orbitScope: 'context',
  flareArtifacts: 1,
  observatory: false,
  chrome: true,
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
 * than a special case: `ViewPanel` pushes `{ showShip: false }` over the
 * planetarium's stance and neither of them has to know about the other.
 */
export function resolveStances(layers: readonly Stance[]): Presentation {
  let resolved = GROUND_STANCE
  for (const layer of layers) {
    resolved = {
      motionBlur: layer.motionBlur ?? resolved.motionBlur,
      showShip: layer.showShip ?? resolved.showShip,
      showOrbits: layer.showOrbits ?? resolved.showOrbits,
      labels: layer.labels ?? resolved.labels,
      orbitScope: layer.orbitScope ?? resolved.orbitScope,
      flareArtifacts: layer.flareArtifacts ?? resolved.flareArtifacts,
      observatory: layer.observatory ?? resolved.observatory,
      chrome: layer.chrome ?? resolved.chrome,
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
      next.labels === last.labels &&
      next.orbitScope === last.orbitScope &&
      next.flareArtifacts === last.flareArtifacts &&
      next.observatory === last.observatory &&
      next.chrome === last.chrome
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
