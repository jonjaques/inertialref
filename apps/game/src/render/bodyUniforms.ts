import {
  OPEN_OCEAN,
  SURFACE_LUMINANCE,
  cloudShellAltitude,
  surfaceColor,
  surfaceVisibilityGain,
  type RenderBody,
  type RenderStar,
} from '@inertialref/rendering'
import { Quaternion, Vec, type Vec3 } from '@inertialref/spatial'

/*
 * What a body's materials are told each frame, as a function of the body and
 * the frame.
 *
 * Every number the sphere, its cloud deck, its rings and its atmosphere shell
 * read is decided here, in Node, with no Three object in reach — so the rules
 * the picture depends on are testable where the rest of the scene's arithmetic
 * is. `scene/Bodies.tsx` owns the meshes and the textures and applies these
 * records to them; what it applies is decided here.
 *
 * The one decision taken here that the frame closure must not take again is
 * the figure branch. A body with a measured figure is drawn from a mesh that
 * already carries its polar squash, so its shells are round about it too:
 * `shellFlattening` is 1 for it, everywhere a shell or an altitude reads one
 * (ADR-0013, rule 25). Each shell taking `body.flattening` for itself is how
 * a figured body would wear clouds squashed by a ratio its surface has already
 * spent.
 */

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** What every body in one frame is lit and seen by. */
export interface BodyFrame {
  /** Render-space position of the key light, `stars[0]`, or null. */
  readonly keyLight: Vec3 | null
  readonly keyColor: Rgb
  /** `engine.visibilityProcessing`: Enhanced staging rather than calibrated. */
  readonly visibility: boolean
  /** The snapshot's presentation instant, never `clock.time`. */
  readonly renderTime: number
  /** The scene's eye, render space. */
  readonly eye: Vec3
}

/**
 * Which of a body's images exist. The textures stay with the component that
 * loads them; the uniforms depend only on whether each one is there.
 */
export interface BodyMaps {
  readonly normal: boolean
  readonly night: boolean
  readonly clouds: boolean
  /** An orbital bake is ready and worn. */
  readonly bake: boolean
}

interface PlanetUniforms {
  readonly baseColor: Rgb
  readonly oceanColor: Rgb
  readonly albedoScale: number
  readonly lunarLambert: number
  readonly terminator: number
  readonly reliefScale: number
  readonly limbDarkening: number
  readonly saturation: number
  readonly flowRate: number
  readonly time: number
  readonly hazeStrength: number
  /** Null where the body has no haze; the material keeps what it held. */
  readonly hazeColor: Rgb | null
  readonly hazeLimb: Rgb | null
  readonly specularStrength: number
  readonly nightStrength: number
  readonly cloudShadow: number
  readonly cloudHeight: number
  readonly ringInner: number
  readonly ringOuter: number
  readonly ringOpacity: number
}

interface StarUniforms {
  readonly color: Rgb
  readonly time: number
  readonly exposure: number
}

interface CloudUniforms {
  /** The shell's scale about the body's center, render meters. */
  readonly scale: Vec3
  readonly entryDistance: number
  readonly eyeAltitude: number
  /** The body's tint for a mapless deck; white for a mapped one. */
  readonly baseColor: Rgb
  /** Null where the body has no haze to take a sunset from. */
  readonly sunsetColor: Rgb | null
  readonly opacity: number
  readonly drift: number
}

interface RingUniforms {
  readonly extent: number
  readonly innerFraction: number
  readonly bodyRadius: number
  readonly opticalDepth: number
  readonly baseColor: Rgb
}

interface AtmosphereUniforms {
  readonly scale: Vec3
  readonly outerRadius: number
  readonly innerRadius: number
  readonly flattening: number
}

/** One body's frame: the transform, and one record per material it draws. */
export interface BodyUniforms {
  /** Drawn from `shapeGeometryFor`, scaled by one number. */
  readonly figured: boolean
  readonly position: Vec3
  readonly scale: Vec3
  /** Behind the streamed ground when the body is drawn as terrain. */
  readonly renderOrder: number
  /** Unit vector toward the key light; null leaves the materials as they are. */
  readonly sun: Vec3 | null
  /** The key light's color, carrying the body's sunlight under calibrated staging. */
  readonly sunColor: Rgb
  readonly spinAxis: Vec3
  /** Exactly one of `star` and `planet` is set. */
  readonly star: StarUniforms | null
  readonly planet: PlanetUniforms | null
  /** Null hides the shell. */
  readonly clouds: CloudUniforms | null
  readonly rings: RingUniforms | null
  readonly atmosphere: AtmosphereUniforms | null
}

/*
 * Per-body shading parameters, from what the body is.
 *
 * The one number worth explaining is `lunarLambert`, the weight between Lambert
 * and Lommel-Seeliger in `planet.ts`. It is not a style knob: it is how much the
 * surface backscatters, it is measured for real bodies, and it is the difference
 * between a Moon that looks like a photograph and one that looks like a
 * billiard ball. Airless regolith is around 0.9; a thick atmosphere scatters its
 * way to something much closer to Lambert.
 */
export interface PlanetTuning {
  readonly lunarLambert: number
  readonly terminator: number
  readonly reliefScale: number
  readonly specular: number
  readonly night: number
  readonly limbDarkening: number
  readonly saturation: number
  /** Equatorial jet, UV turns per second. Real magnitudes; see `planet.ts`. */
  readonly flowRate: number
}

/**
 * The calibrated star disk, in multiples of diffuse white: the radiance the
 * tone curve's ceiling and the granulation are tuned against. `materials.ts`
 * draws the disk at unit radiance and takes this through `exposure`.
 */
export const CALIBRATED_STAR_RADIANCE = 8

/**
 * How large a generated body's disk is, in radians of angular radius, before
 * its bake is asked for. A hundredth is about twelve pixels of radius at the
 * flight lens over the baseline viewport; below it the tint is the picture.
 */
const BAKE_ANGLE = 0.01

const giantKind = (kind: string): boolean =>
  kind === 'gas-giant' || kind === 'ice-giant'

export function tuningFor(body: RenderBody): PlanetTuning {
  const air = body.hasAtmosphere
  const giant = giantKind(body.kind)
  if (giant)
    return {
      // A cloud deck kilometers thick is as close to Lambert as anything gets,
      // and its terminator is soft because there is no surface to end at.
      lunarLambert: 0.1,
      terminator: 0.22,
      reliefScale: 0,
      specular: 0,
      night: 0,
      // The two knobs that separate a decal from a photograph of a giant:
      // the disk rolls off toward the limb, and the published near-true-color
      // maps get the chroma stretch every released image has had.
      limbDarkening: 0.72,
      saturation: body.kind === 'gas-giant' ? 1.3 : 1.15,
      // ~110 m/s of equatorial jet for a gas giant, ~400 m/s for an ice
      // giant (Neptune's winds are the fastest in the system), as a fraction
      // of a typical circumference per second.
      flowRate: body.kind === 'gas-giant' ? 2.5e-7 : 2.5e-6,
    }
  return {
    // Close to Lambert under air: the aerial veil brightens the limb on top
    // of this, and 0.45 under the veil leaves the disk reading flat.
    lunarLambert: air ? 0.3 : 0.92,
    /*
     * The same number the ground uses, from the same producer.
     *
     * A disk and the terrain streamed in front of it are one body, and a
     * descent crosses between them at the eight-pixel relief gate — so a
     * terminator each of them derived for itself is a step at the switch:
     * 4.2× on Luna and 6.6× on Iapetus, where the ground widens its band by
     * the body's own relief. `terminatorFor` is where the widening lives;
     * `buildScene` spends it once and both the disk and the ground read the
     * result.
     */
    terminator: body.terminator,
    limbDarkening: 0,
    saturation: 1,
    flowRate: 0,
    /*
     * Normal-map exaggeration, and the honest name for it.
     *
     * At 4096 across, one texel of Earth is ten kilometers, and the real slope
     * across ten kilometers is a fraction of a degree — measured: the normal map
     * has a standard deviation of 2.4 out of 255. Rendered at unity it is
     * invisible. `docs/design/art.md` licenses exactly this ("roughness and
     * detail are art") and forbids the thing next door to it: the *elevation* is
     * the published one, the terrain is where it really is, and only how sharply
     * it catches the light is turned up.
     *
     * The Moon needs far less because its craters are genuinely steep.
     */
    reliefScale: air ? 6 : 2.2,
    specular: 1,
    night: 1,
  }
}

/**
 * Whether the disk is worth an orbital bake. Only where the archive has no
 * photograph — a mapped body's sphere is its map — and only once the disk is
 * worth looking at, because a bake is ninety-six tiles of the producer's time
 * and a point of light does not need one. Asking is what starts the bake.
 */
export const wantsBake = (body: RenderBody): boolean =>
  body.appearance.texture === null &&
  !giantKind(body.kind) &&
  body.placement.angularRadius > BAKE_ANGLE

/** A star is drawn by `createStarMaterial`; none of this reaches it. */
const STAR_APPEARANCE: RenderBody['appearance'] = {
  texture: null,
  maps: [],
  relief: 0,
  geometricAlbedo: 1,
  roughness: 1,
  clouds: null,
  rings: null,
  haze: null,
  color: { r: 1, g: 1, b: 1 },
  pigment: { r: 1, g: 1, b: 1 },
  liquid: null,
}

/** The key a star's visual is resident under, beside the bodies' addresses. */
export const starKey = (star: RenderStar): string => `star:${star.system}`

/**
 * A star as a body, so it is placed and drawn by the same path as a planet.
 * Its sunlight is the disk's radiance: the calibrated figure under Enhanced
 * staging, its luminance in units of the surface white otherwise.
 */
export function starAsBody(star: RenderStar, visibility: boolean): RenderBody {
  return {
    address: starKey(star),
    name: star.name,
    kind: 'star',
    sunlight: visibility
      ? CALIBRATED_STAR_RADIANCE
      : star.luminance / SURFACE_LUMINANCE,
    placement: star.placement,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    hasAtmosphere: false,
    // A star has no surface and no terminator; the disk is unlit.
    terminator: 0,
    atmosphereScale: 1,
    trueRadius: 1,
    rotationPeriod: 1,
    flattening: 1,
    // A star is a sphere, and it is drawn by `createStarMaterial` on a sphere
    // tier regardless.
    figure: null,
    rings: null,
    appearance: STAR_APPEARANCE,
  }
}

const WHITE: Rgb = { r: 1, g: 1, b: 1 }
const UP: Vec3 = { x: 0, y: 1, z: 0 }

/**
 * One body's uniforms for this frame. `star` is the star's rendered color when
 * the body is a star, and null for everything else.
 */
export function bodyUniforms(
  body: RenderBody,
  frame: BodyFrame,
  maps: BodyMaps,
  star: Rgb | null,
): BodyUniforms {
  const { placement, orientation, appearance } = body
  const position = placement.position
  const figured = body.figure !== null
  // The figure branch, taken once: see the header.
  const shellFlattening = figured ? 1 : body.flattening
  const drawn = placement.tier !== 'point'
  const time = frame.renderTime
  const light = frame.visibility ? 1 : body.sunlight
  const sunColor: Rgb = {
    r: frame.keyColor.r * light,
    g: frame.keyColor.g * light,
    b: frame.keyColor.b * light,
  }
  // A body sitting exactly on its star — a star's own entry — leaves the
  // difference zero, and `normalize` returns zero for it rather than NaN.
  const sun =
    frame.keyLight === null
      ? null
      : Vec.normalize(Vec.sub(frame.keyLight, position))
  const spinAxis = Vec.normalize(Quaternion.rotate(orientation, UP))
  const oblate = (radius: number): Vec3 => ({
    x: radius,
    y: radius * shellFlattening,
    z: radius,
  })

  let starUniforms: StarUniforms | null = null
  let planet: PlanetUniforms | null = null
  if (star !== null) {
    const filling = Math.min(
      1,
      Math.max(0, (placement.angularRadius - 0.015) / 0.085),
    )
    starUniforms = {
      // The color is a uniform rather than a construction argument because a
      // star's rendered color is derived from its temperature every frame.
      color: star,
      // Simulation seconds, so time warp stirs the photosphere faster.
      time,
      exposure: body.sunlight * (frame.visibility ? 1 - filling * 0.9 : 1),
    }
  } else {
    const tuning = tuningFor(body)
    const haze = appearance.haze
    const relief = maps.normal || maps.bake
    planet = {
      baseColor: surfaceColor(appearance),
      /*
       * The sea the bake's mask keys is the liquid's color, the same number
       * the ground's palette and the sheet read, so a magma world does not
       * wear a blue sea from orbit and a red one at the gate. Open-ocean blue
       * where the record names no liquid: a photographed body's mask is in
       * its normal map, and its sea is water.
       */
      oceanColor: appearance.liquid?.color ?? OPEN_OCEAN,
      albedoScale: surfaceVisibilityGain(
        appearance.geometricAlbedo,
        placement.angularRadius,
        frame.visibility,
      ),
      lunarLambert: tuning.lunarLambert,
      terminator: tuning.terminator,
      /*
       * The bake carries relief as the archive's normal map does, and it is
       * exaggerated by the same number for the same reason: at forty
       * kilometers a texel the real slope is a fraction of a degree, and a
       * generated disk drawn at unity is a smooth ball. No map and no bake is
       * the one case with nothing to scale.
       */
      reliefScale: relief ? tuning.reliefScale : 0,
      limbDarkening: tuning.limbDarkening,
      saturation: tuning.saturation,
      flowRate: tuning.flowRate,
      time,
      /*
       * The aerial term reads the same authored haze the shell does, so the
       * air over the ground and the air past the limb cannot disagree about
       * what color the sky is. Giants get less: their "surface" already is
       * cloud-top, and a full-strength veil flattens Jupiter's bands into fog.
       * The veil is what limb-brightens an atmosphere-bearing disk;
       * lunar-Lambert would otherwise leave it too flat to read as a sphere.
       */
      hazeStrength:
        haze === null ? 0 : giantKind(body.kind) ? 0.18 : haze.thickness,
      hazeColor: haze?.color ?? null,
      hazeLimb: haze?.limb ?? null,
      // Sun-glint needs an ocean to land on, and the mask that says where one
      // is rides in the normal map's blue — or in the bake's relief record's.
      specularStrength: relief ? tuning.specular : 0,
      nightStrength: maps.night ? tuning.night : 0,
      cloudShadow: maps.clouds ? 0.55 : 0,
      cloudHeight:
        appearance.clouds === null
          ? 0
          : appearance.clouds.altitude / Math.max(body.trueRadius, 1),
      // In render meters, because the shader measures the sun ray's
      // plane-crossing against `positionWorld` — the dimensionless scales
      // alone sit far inside any drawn sphere and never shadow anything.
      ringInner: (body.rings?.innerScale ?? 0) * placement.scale,
      ringOuter: (body.rings?.outerScale ?? 0) * placement.scale,
      ringOpacity: Math.min(1, body.rings?.opticalDepth ?? 0),
    }
  }

  let clouds: CloudUniforms | null = null
  const deck = appearance.clouds
  if (deck !== null && drawn) {
    /*
     * The shell is lifted to at least 0.4% of the radius.
     *
     * Earth's cloud tops are twelve kilometers up on a radius of six thousand,
     * which is 0.2% and is a shell you cannot see past at the limb. What sells
     * a cloud deck from orbit is precisely that parallax — the clouds
     * overhanging the edge of the disk — and the altitude is not on the list
     * of things a player can check.
     */
    const lift = Math.max(deck.altitude / Math.max(body.trueRadius, 1), 0.004)
    const shell = placement.scale * (1 + lift)
    clouds = {
      scale: oblate(shell),
      // The shell is a thin weather image. Its final quarter-altitude of
      // height clears continuously before the eye enters the deck.
      entryDistance: placement.scale * lift * 0.25,
      eyeAltitude: cloudShellAltitude(
        Vec.sub(frame.eye, position),
        orientation,
        shell,
        shellFlattening,
      ),
      // A deck with no map — Titan's, and every procedural world's — is drawn
      // from the body's tint over the opaque fallback texel; a mapped deck
      // keeps its own colors untinted.
      baseColor: maps.clouds ? WHITE : appearance.color,
      // The deck's dusk color is the body's authored sunset, so clouds and
      // air agree about what the low sun does here.
      sunsetColor: appearance.haze?.limb ?? null,
      opacity: deck.opacity,
      // The deck turns against the surface, whose quaternion already spins at
      // the body's own period — so the drift is the *difference* of the two
      // rates. A fixed 24-hour day here would give Venus's deck a spurious
      // daily lap and slide Titan's around a tidally locked moon.
      drift: time / deck.rotationPeriod - time / body.rotationPeriod,
    }
  }

  let rings: RingUniforms | null = null
  const ring = body.rings
  if (ring !== null && drawn)
    rings = {
      extent: placement.scale * ring.outerScale,
      innerFraction: ring.innerScale / ring.outerScale,
      // In render meters: the eclipse test runs on `positionWorld`, so a
      // mesh-local value (1/outerScale) never shadows a single fragment.
      bodyRadius: placement.scale,
      opticalDepth: ring.opticalDepth,
      // A generated strip carries its own grays — re-dying it with the body's
      // tint turns Uranus's charcoal threads cyan. Only a photographed strip
      // is neutral enough to take the tint.
      baseColor: ring.texture === null ? WHITE : appearance.color,
    }

  let atmosphere: AtmosphereUniforms | null = null
  if (body.hasAtmosphere && drawn) {
    const shell = placement.scale * body.atmosphereScale
    /*
     * Oblate like the body it wraps, or the shell floats a tenth of a radius
     * off Saturn's poles; the shader unstretches it. The shell's shader needs
     * the same geometry the transform encodes, in render space, because it
     * integrates along the view ray rather than shading a surface — and both
     * radii move whenever distance compression changes the tier.
     */
    atmosphere = {
      scale: oblate(shell),
      outerRadius: shell,
      innerRadius: placement.scale,
      flattening: shellFlattening,
    }
  }

  return {
    figured,
    position,
    /*
     * A body with no figure is a spheroid: a unit sphere squashed along its
     * spin axis by the measured flattening, in the body's own frame so the
     * quaternion tilts the bulge with the axis. A body with one is drawn from
     * a mesh normalized to `trueRadius` that already carries its three
     * half-extents, so it scales by one number.
     */
    scale: oblate(placement.scale),
    // A body drawn as streamed terrain does not also need its datum sphere,
    // except as the sea floor below it.
    renderOrder: placement.tier === 'surface' ? -1 : 0,
    sun,
    sunColor,
    spinAxis,
    star: starUniforms,
    planet,
    clouds,
    rings,
    atmosphere,
  }
}
