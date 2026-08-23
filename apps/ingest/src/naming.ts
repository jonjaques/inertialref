import { bayerName, flamsteedName, glieseName } from '@inertialref/universe'

/*
 * Choosing the one name that goes on screen.
 *
 * The catalog offers up to seven for a star and the HUD has room for one. The
 * rule below is short, and every clause in it is there because a star broke the
 * clause above it.
 */

export interface NameSource {
  readonly proper: string
  /** Apparent visual magnitude. Lower is brighter; the Sun is −26.7. */
  readonly apparentMagnitude: number
  readonly bayer: string
  readonly flamsteed: string
  readonly constellation: string
  readonly gliese: string
  readonly hip: number
  readonly hd: number
  readonly hr: number
}

/**
 * The common name for a system, from every component of it.
 *
 * The order is "most familiar first", not "most authoritative first" — this is
 * the opposite of `canonicalSystemId`, and deliberately so. An id must be stable
 * and nobody reads it; a name must be recognisable and nobody depends on it.
 *
 * Two clauses are subtle and both were arrived at by looking at what came out.
 *
 * **The proper-name count.** An IAU proper name normally wins outright: `Sirius`
 * beats `Alpha Canis Majoris`, which is what anybody would want. But α
 * Centauri's two components are named *Rigil Kentaurus* and *Toliman*, and
 * neither of those names the system — they name one star each, with equal
 * claim. So when more than one component carries a proper name, the shared Bayer
 * designation is the only name that refers to the whole thing.
 *
 * **The magnitude threshold.** HYG's proper names come from the IAU Working
 * Group on Star Names, which contains both `Sirius` and `Ran` — and nobody has
 * ever called ε Eridani "Ran". The two kinds of name are distinguishable, and
 * brightness is what distinguishes them: the classical names attached to stars
 * that people could see and did look at for centuries, while the 2015–2018
 * assignments largely went to fainter stars whose designations were already the
 * name in use. So a proper name wins above naked-eye prominence and loses below
 * it. Every classical name this has to get right — Sirius, Vega, Altair,
 * Procyon, Fomalhaut, Pollux, Arcturus, Aldebaran, Betelgeuse — is brighter than
 * magnitude 2, and every recent assignment it has to overrule — Ran (3.7), Keid
 * (4.4), Helvetios of 51 Pegasi (5.5), Cervantes of μ Arae (5.1) — is fainter
 * than 3.
 *
 * The cost, since a threshold always has one: Alcor is magnitude 4.0 and a
 * classical name, and comes out as `80 Ursae Majoris`. It is 82 light-years away
 * and it is still reachable by search. Ran and Keid are five and sixteen light
 * years away and are places a player will actually go.
 */

/** Above this magnitude a proper name loses to the star's designation. */
const NAKED_EYE_PROMINENCE = 3
export function chooseCommonName(
  components: readonly NameSource[],
  fallback: string,
): string {
  const primary = components[0]
  if (primary === undefined) return fallback

  const named = components.filter((c) => c.proper !== '')
  /*
   * `Castor` and `Castor B` are one name, not two.
   *
   * The catalog names secondaries by appending the component letter, so a
   * plain string comparison sees two distinct proper names and concludes that
   * neither can stand for the system — which turned Castor into
   * "Alpha Geminorum". Rigil Kentaurus and Toliman are still two names by this
   * test, which is the case the comparison exists for.
   */
  const distinctNames = new Set(
    named.map((c) => c.proper.replace(/ [A-C]$/, '')),
  )

  /*
   * The Bayer superscript is dropped only when a sibling component also carries
   * a Bayer letter — which, within one system, means they differ by nothing else
   * (α¹ and α² Cen), so the letter alone names the pair.
   *
   * Dropping it whenever a system is *multiple* was the first attempt and it is
   * wrong in a way that collides two systems onto one name: ο² Eridani is a
   * triple whose siblings have no Bayer letter of their own, and calling it
   * "Omicron Eridani" takes the name of ο¹ Eridani, a different and unrelated
   * star.
   */
  const lettered = components.filter((c) => c.bayer !== '').length
  const bayer = bayerName(primary.bayer, primary.constellation, lettered < 2)
  const flamsteed = flamsteedName(primary.flamsteed, primary.constellation)

  /*
   * A superscripted Bayer letter loses to a Flamsteed number.
   *
   * ρ¹ Cancri is 55 Cancri, and everything ever written about its planets calls
   * it 55 Cancri — because the superscript exists precisely to disambiguate a
   * letter that was not unique, and a plain number never had that problem.
   * Without a superscript the Bayer name is the one in use: τ Ceti is Tau Ceti,
   * never 52 Ceti.
   */
  const designation =
    bayer !== null && !(bayer.hasSuperscript && flamsteed !== null)
      ? bayer.text
      : (flamsteed ?? bayer?.text ?? null)

  /*
   * More than one component named, and they disagree: no single proper name
   * refers to the system. Rigil Kentaurus and Toliman name one star each, with
   * equal claim, so α Centauri's name has to be the designation.
   *
   * If they *agree* — both components of Castor are called Castor — then the
   * name does refer to the whole system and there is nothing to disambiguate.
   */
  if (distinctNames.size > 1 && designation !== null) return designation

  const named0 = named[0]
  if (named0 !== undefined) {
    if (
      named0.apparentMagnitude <= NAKED_EYE_PROMINENCE ||
      designation === null
    )
      return named0.proper
    return designation
  }

  return (
    designation ??
    glieseName(primary.gliese) ??
    (primary.hip > 0 ? `HIP ${primary.hip}` : null) ??
    (primary.hd > 0 ? `HD ${primary.hd}` : null) ??
    (primary.hr > 0 ? `HR ${primary.hr}` : null) ??
    fallback
  )
}
