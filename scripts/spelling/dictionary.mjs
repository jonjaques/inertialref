/*
 * British → American, as ordered rewrite rules over a single word.
 *
 * Not a flat word list, because a list cannot inflect: the corpus holds
 * `colour`, `colours`, `coloured`, `colourIndex`, `keyColour` and `COLOUR_LUT`,
 * and enumerating those six is how the seventh gets missed. Each rule is a
 * fragment, so one entry covers every inflection of the stem.
 *
 * ORDER IS LOAD-BEARING. The rules run top to bottom and the first match on a
 * region wins, so the irregular inflections have to precede the stem they
 * contain. `centred` must be rewritten before `centre`, or the stem rule
 * reaches it first and produces `centerd`. Every rule whose American form is
 * not a plain substitution of the stem is listed above that stem for the same
 * reason.
 *
 * WHAT IS DELIBERATELY ABSENT is as important as what is here.
 *
 *  - No blanket `-ise` → `-ize`. The suffix is not a reliable signal: `promise`,
 *    `precise`, `exercise`, `otherwise`, `expertise`, `revise`, `noise` and
 *    `raise` are all American English already, and several of them appear in
 *    this tree. The `-ise` verbs are enumerated one by one instead.
 *  - No `tyre`. The word does not occur in a space simulator, and the fragment
 *    does: `CapabilityResult` contains `tyRe`. A case-insensitive fragment
 *    search for it is a false positive generator and nothing else.
 *  - No `programme`, `storey`, `kerb`, `plough`, `pyjamas`. None occurs, and an
 *    unexercised rule is a rule nobody has checked.
 *  - No `analogue`/`catalogue` → `analog`/`catalog` in this table. `catalogue`
 *    is real here and it is a rename of files as well as identifiers, which is
 *    a different operation with a different blast radius; it is handled as its
 *    own step rather than smuggled in beside `colour`.
 *
 * Fragments match case-insensitively and the replacement adopts the case of the
 * text it replaces, so one rule serves `colour`, `Colour` and `COLOUR`.
 */
export const RULES = [
  // -- inflections that are not a plain substitution of their stem ----------
  ['centred', 'centered'],
  ['centring', 'centering'],
  ['modelling', 'modeling'],
  ['modelled', 'modeled'],
  ['travelling', 'traveling'],
  ['travelled', 'traveled'],
  ['labelling', 'labeling'],
  ['labelled', 'labeled'],
  ['cancelling', 'canceling'],
  ['cancelled', 'canceled'],
  ['signalling', 'signaling'],
  ['signalled', 'signaled'],
  ['fuelled', 'fueled'],
  ['levelled', 'leveled'],

  // -- stems ---------------------------------------------------------------
  ['colour', 'color'],
  ['centre', 'center'],
  ['metre', 'meter'],
  ['litre', 'liter'],
  ['fibre', 'fiber'],
  ['sabre', 'saber'],
  ['behaviour', 'behavior'],
  ['favour', 'favor'],
  ['honour', 'honor'],
  ['labour', 'labor'],
  ['neighbour', 'neighbor'],
  ['armour', 'armor'],
  ['vapour', 'vapor'],
  ['harbour', 'harbor'],
  ['rumour', 'rumor'],
  ['savour', 'savor'],
  ['flavour', 'flavor'],
  ['humour', 'humor'],
  ['defence', 'defense'],
  ['offence', 'offense'],
  ['licence', 'license'],
  ['artefact', 'artifact'],
  ['aluminium', 'aluminum'],
  ['sulphur', 'sulfur'],
  ['sulphate', 'sulfate'],
  ['manoeuvre', 'maneuver'],
  ['grey', 'gray'],
  ['mould', 'mold'],
  ['smoulder', 'smolder'],
  ['speciality', 'specialty'],
  ['encyclopaedia', 'encyclopedia'],
  ['haemo', 'hemo'],
  ['oesoph', 'esoph'],

  // -- the enumerated `-ise` verbs, and `-yse` -----------------------------
  ['analyse', 'analyze'],
  ['paralyse', 'paralyze'],
  ['catalyse', 'catalyze'],
  ['normalis', 'normaliz'],
  ['initialis', 'initializ'],
  ['serialis', 'serializ'],
  ['optimis', 'optimiz'],
  ['minimis', 'minimiz'],
  ['maximis', 'maximiz'],
  ['visualis', 'visualiz'],
  ['organis', 'organiz'],
  ['realis', 'realiz'],
  ['synchronis', 'synchroniz'],
  ['randomis', 'randomiz'],
  ['quantis', 'quantiz'],
  ['discretis', 'discretiz'],
  ['linearis', 'lineariz'],
  ['parameteris', 'parameteriz'],
  ['sanitis', 'sanitiz'],
  ['prioritis', 'prioritiz'],
  ['emphasis', 'emphasiz'], // see NOTE below — guarded, not applied blind
  ['summaris', 'summariz'],
  ['categoris', 'categoriz'],
  ['characteris', 'characteriz'],
  ['stabilis', 'stabiliz'],
  ['utilis', 'utiliz'],
  ['recognis', 'recogniz'],
  ['polaris', 'polariz'],
  ['rasteris', 'rasteriz'],
  ['tokenis', 'tokeniz'],
  ['modularis', 'modulariz'],
  ['vaporis', 'vaporiz'],
  ['energis', 'energiz'],
]

/*
 * `emphasis` is a noun in both Englishes and `emphasise` is the British verb,
 * so the fragment above would turn the correct noun into `emphasiz`. It is kept
 * in the table because the verb does need rewriting, and gated here instead:
 * the rule only fires when a letter that can only belong to the verb follows.
 */
const GUARDED = new Map([['emphasis', /emphasis(e|ed|es|ing)/i]])

const CASE = {
  upper: (s) => s.toUpperCase(),
  title: (s) => s[0].toUpperCase() + s.slice(1),
  lower: (s) => s.toLowerCase(),
}

/** Which of the three casings `matched` is written in. */
function casingOf(matched) {
  if (matched === matched.toUpperCase() && /[A-Z]/.test(matched)) return 'upper'
  if (matched[0] === matched[0].toUpperCase()) return 'title'
  return 'lower'
}

/**
 * Rewrite every British fragment in `word`, preserving the case of each region
 * it replaces. Returns the word unchanged when no rule fires, so the caller can
 * compare by identity.
 */
export function americanize(word) {
  let out = word
  for (const [from, to] of RULES) {
    const guard = GUARDED.get(from)
    if (guard !== undefined && !guard.test(out)) continue
    out = out.replace(new RegExp(from, 'gi'), (m) => CASE[casingOf(m)](to))
  }
  return out
}

/** Every rule that fires on `word`, for reporting which spelling was found. */
export function rulesFiring(word) {
  return RULES.filter(([from]) => {
    const guard = GUARDED.get(from)
    if (guard !== undefined) return guard.test(word)
    return new RegExp(from, 'i').test(word)
  }).map(([from]) => from)
}
