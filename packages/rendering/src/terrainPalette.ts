import type { Meters } from '@inertialref/shared'
import {
  type Body,
  type LinearRgb,
  seaDatumElevation,
} from '@inertialref/universe'

/*
 * What the six surface materials look like on one body.
 *
 * The design bible names eight biomes and two of them wait for flora
 * ([content § biomes](../../../docs/design/content.md#biomes)); the six that
 * are left are here, and they are the deposits a solid body can carry. Which
 * one a fragment wears is decided in the material from latitude, altitude,
 * slope and the cover field — a shader has all four — so nothing in this file
 * classifies anything. It says only what each of them *looks like*, on this
 * body, and it is plain data so that it can be read in Node.
 *
 * **Every material is a modifier on the body's own published colour rather than
 * a colour of its own.** That is the one decision here that shapes everything
 * else. A palette of absolute colours makes every rocky world the same shade of
 * sandstone — which is the thing this phase exists to end — and, worse, it
 * makes the terrain disagree with the datum sphere, the orbital tier and the
 * dossier's own swatch, all of which read `appearance.colour`. Expressed as
 * ratios, Mars stays ochre and Callisto stays grey while both get the same
 * internal contrast between a mare and a highland.
 *
 * The ratios are published where anyone has published them. Lunar mare is 0.07
 * geometric albedo against 0.13 for the highlands, so basalt is 0.54 of the
 * reference and not a number that looked right.
 */

/** One deposit: what it reflects, and how it takes the light. */
export interface SurfaceMaterial {
  /** Diffuse reflectance, linear, before the mineral tint. */
  readonly albedo: LinearRgb
  /** Microfacet roughness. 1 is a powder; rock is near it. */
  readonly roughness: number
  /** How strongly the detail field mottles the albedo, 0..1. */
  readonly grain: number
  /** How strongly it perturbs the normal below the mesh's own resolution. */
  readonly bump: number
}

/**
 * The whole surface appearance of one body.
 *
 * Written to the material as uniforms once per frame. It is a function of the
 * body and nothing else — no camera, no time — so it could be computed once and
 * kept; it is recomputed because it is twenty multiplies and a cache keyed by
 * body address is a thing to invalidate.
 */
export interface TerrainPalette {
  /** Exposed bedrock: what a slope too steep to hold anything wears. */
  readonly rock: SurfaceMaterial
  /** The mature mantle — dust and rubble — which is most of an airless world. */
  readonly regolith: SurfaceMaterial
  /** Flood basalt: the dark smooth plains that pond in basins. */
  readonly basalt: SurfaceMaterial
  /** Wind-sorted fines: dune seas and drift. */
  readonly sand: SurfaceMaterial
  /** Evaporite: the bright crust a standing liquid leaves when it goes. */
  readonly evaporite: SurfaceMaterial
  /** Condensed volatiles: caps, frost and an ice shell. */
  readonly ice: SurfaceMaterial

  /** Multiplicative tint at the two ends of the body's compositional ramp. */
  readonly mineralLow: LinearRgb
  readonly mineralHigh: LinearRgb

  /**
   * How much brighter impact-fresh material is than the ground it lies on.
   *
   * Lunar ray systems run 1.3 to 1.8 times the local albedo, which is what
   * makes Tycho visible from Earth with no instrument at all.
   */
  readonly freshGain: number

  /**
   * How much of the photometric blend is Lommel-Seeliger.
   *
   * The same split `Bodies.tsx` gives the body material, and it has to be the
   * same or the streamed ground and the sphere behind it shade differently at
   * the terminator: a powder backscatters, so an airless world is nearly flat
   * across its disk and falls off a cliff at the shadow line, while a surface
   * under air is much closer to Lambert.
   */
  readonly lunarLambert: number
  /** Half-width of the terminator, in cosine of the incidence angle. */
  readonly terminator: number

  /** Whether wind can sort fines here at all, 0..1. */
  readonly aeolian: number
  /** Whether a liquid ever stood here to leave a crust behind, 0..1. */
  readonly evaporitic: number

  /**
   * The steepest ground loose material rests on, as `1 − cos θ`.
   *
   * The angle of repose for dry granular material is about 33° whatever it is
   * made of, which is a fact about friction rather than about a planet. Past it
   * a slope sheds its mantle and shows the rock underneath, and that is the
   * single thing that makes a crater wall read as a crater wall.
   */
  readonly repose: number

  /** Peak-to-datum relief, meters — what altitude is measured against. */
  readonly maxElevation: Meters
  /** The ocean datum in meters, or null on a dry world. */
  readonly seaLevel: Meters | null
  /** What deep water looks like from above. */
  readonly oceanColour: LinearRgb

  /** What a low sun turns, and how much air there is to turn it. */
  readonly sunsetTint: LinearRgb
  readonly airThickness: number
  /**
   * What the sky over this ground is, as a **tint** of unit luminance.
   *
   * The atmosphere shell in front of the terrain carries the light scattered
   * *between* the camera and the ground; what it cannot do is put light on the
   * ground, so this is the other half — and without it a Martian crater floor
   * at low sun is black, which no photograph of Mars has ever been.
   *
   * Normalized, because how much light the sky delivers is `airThickness` and
   * this is only what colour it arrives in. Left as the haze's own values the
   * two multiply and a thin warm sky is dimmer than a thin blue one for no
   * reason anybody could name.
   */
  readonly skyColour: LinearRgb
  /**
   * The archive's texture-set key for this body, or null.
   *
   * A key, not a path, for the reason `BodyAppearance.texture` is one — and it
   * is here because it is what tells the material which of two things the
   * colours beside it are: reflectances, or ratios to multiply a published map
   * by.
   */
  readonly textureKey: string | null
}

/** The angle of repose, as `1 − cos 33°`. */
const REPOSE = 1 - Math.cos((33 * Math.PI) / 180)

/**
 * Mare against highland, measured: 0.07 geometric albedo against 0.13.
 *
 * The one ratio in this file that is a published number rather than a
 * judgment, and the largest albedo contrast on any airless body — so it is
 * what everything else is scaled beside.
 */
const BASALT_RATIO = 0.07 / 0.13

/** The brightest a surface may reflect. Fresh snow is 0.9 and nothing beats it. */
export const REFLECTANCE_CEILING = 0.88

/**
 * The albedo the scene's own exposure already suits.
 *
 * The same constant `Bodies.tsx` reads, and it has to be: a body dark enough
 * that its sphere is lifted while its ground is not draws a planet with two
 * exposures on it, along the line where the terrain stops.
 */
const ADAPTED_ALBEDO = 0.12

/**
 * What the reference deposit on this body reflects, and in what hue.
 *
 * **`BodyAppearance.colour` means two different things and the difference is a
 * factor of six.** Its own docstring says so — "used where there is no albedo
 * map, and to tint one that is grayscale" — so on Luna, Mars and every other
 * mapped body it is (1, 1, 1): a tint over a photograph that carries the
 * brightness itself. Read as a reflectance it makes lunar regolith 0.88 against
 * a published 0.136, which is a Moon that blows out to white on the lit side.
 *
 * So the two cases are separated the way the streaming carve-out separates
 * them, mechanically, on whether a texture resolves. A mapless body's colour
 * *is* what its sphere draws, and matching it is what keeps the ground and the
 * datum behind it the same object. A mapped body's brightness lives in the
 * archive instead, as the published geometric albedo.
 *
 * The dark-body exposure lift comes along for the same reason. `Bodies.tsx`
 * applies it to a body filling the frame — which is every frame terrain is
 * drawn in, since relief has to cover eight pixels before the streamer starts —
 * so a ground that skipped it would be a darker planet than the sphere it is
 * standing in front of.
 */
function referenceReflectance(body: Body): LinearRgb {
  const appearance = body.appearance
  const colour = appearance.colour
  const grey = luminance(colour)
  const albedo = appearance.geometricAlbedo
  const lift =
    albedo >= ADAPTED_ALBEDO ? 1 : ADAPTED_ALBEDO / Math.max(albedo, 0.01)
  /*
   * A mapped body's reference is *white*, because its map is the reference.
   *
   * The archive's photograph carries both the brightness and the hue, and it
   * carries them at ten kilometres a texel where nothing here has an opinion:
   * Mars is butterscotch, Luna has maria, and neither fact belongs to a
   * generator. So on those bodies every colour below is a pure *ratio* — bedrock
   * is 1.18 of the mantle whatever the mantle is — and the material multiplies
   * the two. That is also what makes the descent hold together, because the
   * sphere the approach view draws is the same photograph.
   */
  if (appearance.texture !== null) {
    return { r: lift, g: lift, b: lift }
  }
  // The hue is the colour's, normalized: a body whose swatch is warm grey stays
  // warm grey whatever its brightness turns out to be.
  /*
   * Ceilinged here rather than per deposit, and that is what keeps a bright
   * body from going featureless.
   *
   * Enceladus reflects 1.375 at full phase — more than it receives, because a
   * geometric albedo is a ratio against a Lambert disk and fresh ice
   * backscatters. Clamped deposit by deposit, its bedrock, its regolith and its
   * ice all land on the ceiling together and the surface loses every contrast
   * it has. Clamping the reference instead leaves the ratios intact: bedrock is
   * still 1.18 of the mantle and a mare is still 0.54 of it, and only the
   * deposits above the brightest one this body can reach are truncated.
   */
  const gain =
    grey > 0
      ? Math.min(grey * lift, REFLECTANCE_CEILING / BRIGHTEST_RATIO) / grey
      : 0
  return { r: colour.r * gain, g: colour.g * gain, b: colour.b * gain }
}

/** The largest multiple of the reference any reachable deposit takes. Bedrock. */
const BRIGHTEST_RATIO = 1.18

const luminance = (c: LinearRgb): number =>
  0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

/** A colour rescaled to luminance 1, or white where there is none. */
function unitLuminance(colour: LinearRgb | undefined): LinearRgb {
  if (colour === undefined) return { r: 1, g: 1, b: 1 }
  const grey = luminance(colour)
  if (!(grey > 0)) return { r: 1, g: 1, b: 1 }
  return { r: colour.r / grey, g: colour.g / grey, b: colour.b / grey }
}

export function terrainPalette(body: Body): TerrainPalette {
  const grammar = body.surface.grammar
  const base = referenceReflectance(body)
  const air = grammar.air
  const sea = body.surface.seaLevel

  /*
   * Whether a liquid ever stood here to evaporate.
   *
   * Air alone is not the condition — Venus has a hundred times Earth's column
   * and its ground is at 920 K, where nothing has ever pooled and dried. The
   * window is generous at the top because "ever" covers a body's whole history
   * and the generator carries one temperature.
   */
  const liquidEver =
    air > 0 && grammar.groundTemperature < 450
      ? Math.min(1, air * 1.5) * (sea === null ? 0.35 : 1)
      : 0

  return {
    /*
     * Bedrock is *brighter* than the mantle over it, not darker, and that is
     * space weathering rather than a preference. Micrometeorites and the solar
     * wind darken and redden an exposed surface over hundreds of millions of
     * years; a slope steep enough to shed its regolith is continually
     * resurfaced by mass wasting, so it stays fresh. It is why crater walls
     * are the bright streaks on the Moon and why the ratio runs the way it
     * does here.
     */
    rock: {
      albedo: scale(base, 1.18, 0.94),
      roughness: 0.95,
      grain: 0.3,
      bump: 1,
    },
    regolith: {
      albedo: scale(base, 1, 1),
      roughness: 1,
      grain: 0.18,
      bump: 0.55,
    },
    basalt: {
      albedo: scale(base, BASALT_RATIO, 0.86),
      roughness: 0.95,
      grain: 0.12,
      bump: 0.4,
    },
    sand: {
      albedo: scale(base, 1.22, 1.12),
      roughness: 0.9,
      grain: 0.1,
      // Ripples and slip faces: fines carry more relief per meter than the rock
      // under them, which is what a dune sea is.
      bump: 0.75,
    },
    evaporite: {
      albedo: scale(base, 2.4, 0.45),
      roughness: 0.72,
      grain: 0.08,
      bump: 0.15,
    },
    /*
     * Ice is the one material that is not mostly the body's own colour: frozen
     * volatiles are frozen volatiles, and Mars's cap is white on an ochre
     * planet rather than a paler ochre. What survives of the base is the dust
     * mixed into it, which is why the cap is dirtier the more air there is to
     * carry dust onto it.
     */
    ice: {
      albedo: mixToward(
        scale(base, 1.6, 0.7),
        { r: 0.74, g: 0.79, b: 0.86 },
        0.78 - 0.2 * air,
      ),
      roughness: 0.38,
      grain: 0.06,
      bump: 0.25,
    },

    /*
     * The compositional ramp's two ends, as tints rather than colours, and
     * narrow. Wide ends make a body look painted in two colours; what a real
     * surface shows is provinces that differ by ten or twenty percent — the
     * lunar highlands are not a different colour from each other, they are the
     * same rock with different amounts of iron in it.
     */
    mineralLow: { r: 0.9, g: 0.93, b: 1.02 },
    mineralHigh: { r: 1.1, g: 1.04, b: 0.93 },

    freshGain: 1.6,
    // The same pair `tuningFor` gives the body material. A powder backscatters.
    lunarLambert: air > 0 ? 0.3 : 0.92,
    /*
     * The terminator, widened by the body's own relief.
     *
     * A disk drawn from a photograph ends at 0.025 of a cosine because its
     * surface is smooth at the resolution of the map. Terrain is not: a peak of
     * height `h` catches the sun `√(2h/R)` of a radian past the geometric
     * shadow line, which on Luna's 22 km over 1,737 km is 0.16 — six times the
     * disk's figure. Drawn at the narrower one, every summit past the
     * terminator switches off at once, in a straight line across the planet.
     */
    terminator: Math.max(
      air > 0 ? 0.09 : 0.025,
      Math.sqrt((2 * body.surface.maxElevation) / Math.max(grammar.meanRadius, 1)),
    ),

    // Wind needs air to blow and something loose to move. `dunes` is the
    // grammar's own answer to the second, from the archetype.
    aeolian: Math.min(1, air * 1.4) * Math.max(grammar.dunes, 0.25 * air),
    evaporitic: liquidEver,
    repose: REPOSE,

    maxElevation: body.surface.maxElevation,
    // Through the owner of the sea clamp rather than the formula copied out.
    // `terrain.ts` exports the number for exactly this reason: physics and the
    // mesh once disagreed about where an ocean was because two call sites each
    // typed the remap.
    seaLevel: seaDatumElevation(body.surface),
    // Open-ocean reflectance in linear sRGB — a few percent, blue. The same
    // number `render/planet.ts` uses, for the same reason: what a photograph
    // from orbit shows is water, not the bathymetry underneath it.
    oceanColour: { r: 0.012, g: 0.04, b: 0.13 },

    sunsetTint: body.appearance.haze?.limb ?? { r: 1, g: 1, b: 1 },
    airThickness: body.appearance.haze?.thickness ?? 0,
    skyColour: unitLuminance(body.appearance.haze?.colour),
    textureKey: body.appearance.texture,
  }
}

/**
 * Scale a colour's value and its chroma about its own luminance.
 *
 * Two knobs rather than three multipliers because that is how these materials
 * actually differ: an evaporite crust is brighter *and* paler than the rock it
 * sits on, and a basalt plain is darker and slightly less red. Expressing that
 * as per-channel factors puts the hue in three places and makes a body whose
 * base colour is unusual come out wrong in a way nothing local explains.
 */
function scale(base: LinearRgb, value: number, chroma: number): LinearRgb {
  const grey = luminance(base)
  return {
    r: nonNegative((grey + (base.r - grey) * chroma) * value),
    g: nonNegative((grey + (base.g - grey) * chroma) * value),
    b: nonNegative((grey + (base.b - grey) * chroma) * value),
  }
}

function mixToward(from: LinearRgb, to: LinearRgb, t: number): LinearRgb {
  return {
    r: nonNegative(from.r + (to.r - from.r) * t),
    g: nonNegative(from.g + (to.g - from.g) * t),
    b: nonNegative(from.b + (to.b - from.b) * t),
  }
}

/**
 * The ceiling is spent in the material, not here.
 *
 * On a mapped body these numbers are ratios rather than reflectances — bedrock
 * comes out at 1.18 and means it — so a ceiling applied at this end would clamp
 * the ratio and flatten every contrast the map has. What may not exceed one is
 * the *product*, and only the material has both halves of it.
 */
const nonNegative = (value: number): number => Math.max(0, value)
