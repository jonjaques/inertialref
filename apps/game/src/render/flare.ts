import {
  AddEquation,
  Color,
  CustomBlending,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  type PerspectiveCamera,
  PlaneGeometry,
  Vector3,
  ZeroFactor,
} from 'three/webgpu'
import {
  abs,
  exp,
  float,
  length,
  mix,
  oneMinus,
  pow,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl'
import { edgeFade, type FlareVisibility, ghostPosition } from './flareMath.ts'

/*
 * The lens flare: the camera admitting it is a camera.
 *
 * `docs/design/art.md` § the lens names this directly — "diffraction spikes,
 * ghosting, and a real point-spread function around a star ... It is a lens" —
 * and every reference photograph in `design/inspiration/` carries the
 * signature: a bloomed core, a streak, and iris ghosts strung along the line
 * from the star's image through the frame's centre, because that line is the
 * axis of symmetry of the optics. The red ring in the ISS sunset frame is the
 * classic aperture ghost, mirrored past centre.
 *
 * Screen-space sprites in camera space, not a post pass: the elements are
 * quads parented to a group that is snapped onto the camera every frame, so
 * they cost a handful of draws with no readback and no extra render target.
 * Occlusion is analytic (`flareMath.ts`) — the scene description already
 * knows where every limb is, which is why this can fade *smoothly* as the
 * star sets, something a depth-buffer test answers with a pop.
 *
 * Everything renders additively with depth ignored: a flare happens inside
 * the lens, in front of everything, including the planet that is eclipsing
 * its source — that is why the ISS photographs show ghosts hanging over the
 * dark Earth.
 */

/** How far in front of the camera the quads sit. Arbitrary; depth is ignored. */
const PLANE = 20

/**
 * Where the occluder's limb sits in the corona quad's UV circle: the quad is
 * `CORONA_SPAN`× the disc's diameter, so the limb is at `1/CORONA_SPAN`.
 */
const CORONA_SPAN = 1.9
const CORONA_LIMB = 1 / CORONA_SPAN

/** 0 on the star's image, 1 once a ghost is clear of its glare. */
function smoothFade(distance: number): number {
  const t = Math.min(1, Math.max(0, (distance - 0.08) / (0.3 - 0.08)))
  return t * t * (3 - 2 * t)
}

type ElementKind = 'glow' | 'streak' | 'disc' | 'ring' | 'corona'

interface ElementSpec {
  readonly kind: ElementKind
  /** Position on the sun→centre axis; see `ghostPosition`. */
  readonly t: number
  /** Size as a fraction of the frame's height. */
  readonly size: number
  /** Tint applied on top of the star's colour. */
  readonly tint: readonly [number, number, number]
  /** Radiance multiplier. The glow is authored into HDR headroom on purpose. */
  readonly gain: number
}

/*
 * The recipe. Tints are the classic coating colours — teal and magenta from
 * anti-reflective coatings, the warm ring from the aperture — kept faint: a
 * flare the eye reads as "photograph" is one it barely notices.
 */
const ELEMENTS: readonly ElementSpec[] = [
  // Tuned on the extended-range path, where the tone curve's shoulder lifts
  // everything near white: what reads as restrained on an SDR capture was a
  // furnace on an EDR display, which is where these were re-metered.
  { kind: 'glow', t: 0, size: 0.24, tint: [1, 1, 1], gain: 1.1 },
  { kind: 'streak', t: 0, size: 1.0, tint: [1, 0.95, 0.9], gain: 0.16 },
  { kind: 'disc', t: 0.38, size: 0.05, tint: [0.5, 0.9, 0.85], gain: 0.22 },
  { kind: 'disc', t: 0.62, size: 0.034, tint: [0.95, 0.6, 0.85], gain: 0.18 },
  { kind: 'disc', t: 0.85, size: 0.08, tint: [0.55, 0.75, 0.95], gain: 0.12 },
  { kind: 'disc', t: -0.28, size: 0.045, tint: [1, 0.8, 0.55], gain: 0.15 },
  { kind: 'ring', t: 1.42, size: 0.26, tint: [1, 0.45, 0.4], gain: 0.08 },
]

interface FlareElement {
  readonly spec: ElementSpec
  readonly mesh: Mesh
  readonly tint: { value: Color }
  readonly intensity: { value: number }
}

/**
 * One element's material: a radial profile carried entirely in `colorNode`,
 * added onto the frame. Every element of a kind generates the same WGSL, so
 * the seven quads compile at most four pipelines.
 */
function elementMaterial(kind: ElementKind): {
  material: MeshBasicNodeMaterial
  tint: { value: Color }
  intensity: { value: number }
} {
  const tint = uniform(new Color(1, 1, 1))
  const intensity = uniform(0)

  const centred = uv().sub(0.5).mul(2)
  const r = length(centred)

  let profile
  let colour
  switch (kind) {
    case 'glow': {
      // A point-spread function: a hot core inside a wide skirt, dying before
      // the quad's edge so the square never shows. The skirt is kept lean —
      // at 0.14 it swallowed the whole sunset composition in orange.
      profile = exp(r.mul(-7))
        .add(exp(r.mul(-2.6)).mul(0.05))
        .mul(oneMinus(smoothstep(float(0.8), float(1), r)))
      colour = tint
      break
    }
    case 'streak': {
      // A thin horizontal blade, brightest at the star and fading along its
      // length: the anamorphic smear every sensor gives a bright point.
      const across = abs(centred.y).mul(30)
      const along = oneMinus(smoothstep(float(0), float(1), abs(centred.x)))
      profile = exp(across.negate()).mul(pow(along, 3))
      colour = tint
      break
    }
    case 'disc': {
      // An iris ghost: a soft disc whose rim runs warm — the chromatic
      // fringing real coatings leave on out-of-focus apertures.
      profile = oneMinus(smoothstep(float(0.3), float(0.95), r))
      colour = tint.mul(
        mix(
          vec3(1),
          vec3(1.3, 0.75, 0.6),
          smoothstep(float(0.5), float(0.95), r),
        ),
      )
      break
    }
    case 'ring': {
      // The aperture ghost: a hollow ring, red outside and blue inside, like
      // the one hanging above the limb in the ISS sunset reference — which is
      // a smudge, not a drawn circle, so both edges stay wide and soft.
      profile = smoothstep(float(0.3), float(0.8), r).mul(
        oneMinus(smoothstep(float(0.8), float(1), r)),
      )
      colour = tint.mul(
        mix(
          vec3(0.6, 0.75, 1.3),
          vec3(1.4, 0.6, 0.5),
          smoothstep(float(0.62), float(0.95), r),
        ),
      )
      break
    }
    case 'corona': {
      /*
       * The star's own light around an occulting limb.
       *
       * Not a ghost: this one is anchored on the *body*, sized to its disc,
       * and it is the only thing on screen during a total eclipse — the
       * occluder's night side is by definition unlit, so without it the
       * signature shot of any transit is a hole. The quad is 1.9× the disc, so
       * the limb sits at r = 0.526 and everything inside it stays dark, which
       * is what makes the silhouette read.
       */
      const outside = r.sub(CORONA_LIMB).max(0)
      profile = smoothstep(
        float(CORONA_LIMB - 0.035),
        float(CORONA_LIMB + 0.006),
        r,
      )
        .mul(exp(outside.mul(-11)).add(exp(outside.mul(-3.4)).mul(0.42)))
        .mul(oneMinus(smoothstep(float(0.82), float(1), r)))
      colour = tint
      break
    }
  }

  const material = new MeshBasicNodeMaterial()
  material.colorNode = colour.mul(profile).mul(intensity)
  material.transparent = true
  /*
   * Additive in colour, and **silent in alpha** — not `AdditiveBlending`.
   *
   * three's additive preset blends alpha (One, One), so every flare quad
   * stamps +1 into the framebuffer's alpha channel. The colour math is
   * unaffected — the scene render target is tone-mapped and blitted by RGB —
   * but on the extended path that alpha survives into the `rgba16float`
   * canvas, and Chrome's premultiplied compositing turns each quad's alpha
   * footprint into a visible brightness step: hard rectangles exactly at the
   * quad edges, worst on an EDR display where the compositor's
   * un-premultiply actually divides by it. The profiles were never the
   * problem; the alpha was. Zero/One leaves dst alpha exactly as the scene
   * wrote it.
   */
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = OneFactor
  material.blendDst = OneFactor
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor
  material.depthTest = false
  material.depthWrite = false
  return { material, tint, intensity }
}

export interface LensFlare {
  readonly group: Group
  update(
    camera: PerspectiveCamera,
    sunWorld: { readonly x: number; readonly y: number; readonly z: number },
    starColour: { readonly r: number; readonly g: number; readonly b: number },
    /** Apparent brightness of the star, 0..1 within the scene. */
    brightness: number,
    /** Angular radius of the disc, radians — a close star blooms wider. */
    angularRadius: number,
    occlusion: FlareVisibility,
    /**
     * How much of the artefact stack the lens is showing, 0..1. The flight
     * camera is 1 — the whole point of `art.md` § the lens is that it admits
     * it is a camera. The cinematic camera is a *different* camera and runs
     * near 0: the reference edit's optics put a clean warm ball beside a
     * planet with no ghost chain marching across the frame, and a scripted
     * shot composed around that reads as broken with one.
     */
    artifacts: number,
  ): void
  dispose(): void
}

export function createLensFlare(): LensFlare {
  const group = new Group()
  group.visible = false
  // The quads live at fixed camera-space depth with depth testing off; what
  // keeps them out of the opaque pass's way is draw order alone.
  group.renderOrder = 10

  const quad = new PlaneGeometry(1, 1)
  const elements: FlareElement[] = ELEMENTS.map((spec) => {
    const { material, tint, intensity } = elementMaterial(spec.kind)
    const mesh = new Mesh(quad, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 10
    group.add(mesh)
    return { spec, mesh, tint, intensity }
  })

  const coronaParts = elementMaterial('corona')
  const corona = new Mesh(quad, coronaParts.material)
  corona.frustumCulled = false
  corona.renderOrder = 10
  group.add(corona)

  const projected = new Vector3()
  const view = new Vector3()
  const occluderNdc = new Vector3()

  return {
    group,
    update(
      camera,
      sunWorld,
      starColour,
      brightness,
      angularRadius,
      occlusion,
      artifacts,
    ) {
      // Behind test in view space; NDC alone cannot tell front from back.
      view
        .set(sunWorld.x, sunWorld.y, sunWorld.z)
        .applyMatrix4(camera.matrixWorldInverse)
      const behind = view.z >= 0

      projected.set(sunWorld.x, sunWorld.y, sunWorld.z).project(camera)
      const fade = behind ? 0 : edgeFade(projected.x, projected.y)
      const strength = occlusion.visibility * fade * (0.35 + 0.65 * brightness)

      /*
       * The corona survives the test that hides everything else. Visibility is
       * *zero* at totality, which is precisely when the ring is the shot —
       * gating the whole group on `strength` is what used to leave a total
       * eclipse as an unlit disc on an empty starfield.
       */
      const eclipse = behind ? null : occlusion.eclipse
      const coronaStrength =
        eclipse === null ? 0 : eclipse.depth * fade * (0.35 + 0.65 * brightness)

      if (strength < 0.003 && coronaStrength < 0.003) {
        group.visible = false
        return
      }

      group.visible = true
      group.position.copy(camera.position)
      group.quaternion.copy(camera.quaternion)

      const tanHalf = Math.tan(((camera.fov ?? 65) * Math.PI) / 360)
      const aspect = camera.aspect ?? 1
      const frameHeight = 2 * tanHalf * PLANE
      // A star that subtends real angle blooms wider than a point: the glow
      // tracks the disc so a close pass reads as approaching a *sun*, not a
      // lamp.
      const bloom = 1 + Math.min(3, angularRadius * 30)

      if (eclipse === null || coronaStrength < 0.003) {
        coronaParts.intensity.value = 0
      } else {
        occluderNdc
          .set(eclipse.position.x, eclipse.position.y, eclipse.position.z)
          .project(camera)
        corona.position.set(
          occluderNdc.x * tanHalf * aspect * PLANE,
          occluderNdc.y * tanHalf * PLANE,
          -PLANE,
        )
        // Sized to the occluder's own disc, so the ring lands on its limb
        // wherever the body is and however big it looks.
        const discRadius =
          Math.atan(eclipse.radius / Math.max(eclipse.distance, 1e-6)) * PLANE
        const span = discRadius * 2 * CORONA_SPAN
        corona.scale.set(span, span, 1)
        coronaParts.intensity.value = coronaStrength * 1.9
        /*
         * A corona is the star's light bent past a limb, so it carries the
         * star's colour warmed the way a grazing sight line always is — and
         * warmed hard. Measured off the reference's totality, the ring runs
         * about (230, 150, 20): the green channel at two-thirds and the blue
         * nearly gone. Anything gentler tone-maps to cream, because the ring
         * is bright enough to sit on the curve's shoulder where saturation
         * goes to die.
         */
        coronaParts.tint.value.setRGB(
          starColour.r * 1.3,
          starColour.g * 0.58,
          starColour.b * 0.14,
        )
      }

      for (const element of elements) {
        const { spec } = element
        const at = ghostPosition(projected.x, projected.y, spec.t)
        element.mesh.position.set(
          at.x * tanHalf * aspect * PLANE,
          at.y * tanHalf * PLANE,
          -PLANE,
        )
        const core = spec.t === 0
        const scale = spec.size * frameHeight * (core ? bloom : 1)
        // The streak is a blade: wide, and a tenth as tall.
        element.mesh.scale.set(
          spec.kind === 'streak' ? scale * 2.2 : scale,
          spec.kind === 'streak' ? scale * 0.1 : scale,
          1,
        )

        /*
         * Grazing a limb reddens everything: the light arriving at the lens
         * has crossed the deepest slant of whatever air hangs over that limb.
         * Ghosts redden ahead of the core — they are dimmer, so the sunset
         * takes them first.
         */
        const warm = occlusion.graze * (core ? 0.75 : 0.9)
        element.tint.value.setRGB(
          starColour.r * spec.tint[0] * (1 + warm * 0.15),
          starColour.g * spec.tint[1] * (1 - warm * 0.45),
          starColour.b * spec.tint[2] * (1 - warm * 0.7),
        )
        /*
         * A ghost that lands on the star's own image is swamped by the glare
         * in a real photograph; drawn at full strength here it reads as a
         * targeting reticle around a centred sun. Distance in aspect-corrected
         * NDC, so the fade ring is a circle on screen, not an ellipse.
         */
        const nearSun = core
          ? 1
          : smoothFade(
              Math.hypot((at.x - projected.x) * aspect, at.y - projected.y),
            )
        // The core glow is the star; everything else is the lens talking, and
        // `artifacts` is how loudly this lens is allowed to talk. The streak
        // counts as artefact even though it sits on the core — a blade across
        // the frame is the single most obviously *photographic* element here.
        const lens = spec.kind === 'glow' ? 1 : artifacts
        element.intensity.value = spec.gain * strength * nearSun * lens
      }
    },
    dispose() {
      for (const element of [...elements.map((e) => e.mesh), corona]) {
        element.removeFromParent()
        const material = element.material
        if (!Array.isArray(material)) material.dispose()
      }
      quad.dispose()
    },
  }
}
