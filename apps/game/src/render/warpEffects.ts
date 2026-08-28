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
  vec2,
  vec3,
} from 'three/tsl'
import {
  apparentWidth,
  smooth,
  verticalFov,
  verticalFovDegrees,
} from '@inertialref/rendering'
import type { CinematicView } from '../engine/GameEngine.ts'

/*
 * The cutscene's light show: warp streaks, nacelle glow, the flash wash, the
 * warp-out stretch and the motion smear. Everything the reference edit does
 * with light that is not a body, a star or the hull itself.
 *
 * Camera-space additive quads on the lens-flare pattern (`flare.ts`), not a
 * post pass: the budget allows ~3 ms for atmosphere *plus* post, and a
 * handful of quads that are invisible outside a cutscene costs nothing the
 * rest of the time. Same blending discipline as the flare — additive in
 * color, silent in alpha (`Zero`/`One`), because an alpha-writing additive
 * quad stamps visible rectangles into the extended-range canvas.
 *
 * The "motion blur" here is the smear: a blade stretched between the hull's
 * screen position last frame and this frame, driven by apparent speed. At the
 * three fly-through occlusions the hull crosses the frame in a handful of
 * frames, which is exactly when a velocity streak reads as blur — a true
 * velocity-buffer pass would spend milliseconds every frame to improve
 * roughly forty of them.
 */

/** How far in front of the camera the quads sit. Arbitrary; depth is ignored. */
const PLANE = 20

/**
 * Nacelle centers in hull axes, as fractions of overall length: port and
 * starboard, aft of amidships, just above the engineering hull. Approximate
 * on purpose — the glow quads are soft enough that a few meters of error
 * disappears inside the bloom, and the alternative is asking the glTF for
 * named nodes it does not have.
 */
const NACELLES: readonly [number, number, number][] = [
  [-0.115, 0.03, 0.24],
  [0.115, 0.03, 0.24],
]

type WarpKind = 'wash' | 'glow' | 'streak' | 'spark' | 'stretch'

interface WarpElement {
  readonly mesh: Mesh
  readonly tint: { value: Color }
  readonly intensity: { value: number }
}

function warpMaterial(kind: WarpKind): WarpElement {
  const tint = uniform(new Color(1, 1, 1))
  const intensity = uniform(0)

  const centred = uv().sub(0.5).mul(2)
  const r = length(centred)

  let profile
  let colour
  switch (kind) {
    case 'wash': {
      /*
       * The whiteout: a hot core that saturates to white through the tone
       * curve, falling to blue at the frame's edges — the measured flash is
       * blue-rimmed, not a flat card. The quad is oversized, so the profile
       * must reach zero well inside the UV square or the edge shows.
       *
       * The exponents are what make it a *flash* rather than a card, and they
       * are measured. At 2.2/0.9 over a quad 4.4 frame heights across, the
       * profile only fell from 1.35 at the anchor to 0.59 at the frame's
       * corner: nowhere in the picture was more than half a stop off the core,
       * so the tone curve's shoulder took the whole frame to white together.
       * Captured, that read as mean 130–138 across f1088–1096 against the
       * reference's 81–100, and — worse — as `subj_w` 1.000: the wash itself
       * was the largest bright mass in a shot whose subject is supposed to be
       * a ship. Steepened by 4.4/2.6 (the ratio that would have come from
       * shrinking the quad to 2.6 instead) the same profile falls 1.35 → 0.35
       * over the frame, which is a vignette. The quad stays 4.4 across because
       * the anchor rides the hull: at 2.6 an off-center anchor brings the
       * quad's own edge — where this profile is still 0.10 — into frame.
       */
      profile = exp(r.mul(-3.72)).add(exp(r.mul(-1.52)).mul(0.35))
      /*
       * Deep blue at the edges, white only in the core. The reference's flash
       * is *blue* — measured around (40, 90, 200) across most of the frame
       * with a white center over the nacelles — and a wash whose edges start
       * near white has nowhere to go but a blank page once the tone curve's
       * shoulder gets hold of it.
       *
       * 8.0, not 2.6, and this exponent is the one `compare_render.py` reads:
       * its subject mask drops any pixel whose blue clears red by 90, so the
       * blue field is invisible to it and the white core *is* the measured
       * subject. At 2.6 that core covered two fifths of the frame. At 8.0 it
       * is a third of a frame across — the "white center over the nacelles"
       * the reference measures, and small enough that the stretch below is
       * what sets the subject's width.
       */
      colour = mix(vec3(0.05, 0.22, 1.5), vec3(0.9, 1.0, 1.5), exp(r.mul(-8)))
      break
    }
    case 'glow': {
      // A nacelle grille: a tight core in a narrow skirt. The skirt is
      // deliberately leaner than the flare's — two of these sit close
      // together and wide skirts merge into one blob. Color comes from the
      // tint uniform alone, applied once at the end.
      profile = exp(r.mul(-9))
        .add(exp(r.mul(-3.2)).mul(0.16))
        .mul(oneMinus(smoothstep(float(0.8), float(1), r)))
      colour = vec3(1)
      break
    }
    case 'streak': {
      // A warp streak: brightest at its origin end (u = 0), dying along its
      // length, thin across. The asymmetry matters — a symmetric blade reads
      // as an anamorphic flare, not as light being left behind.
      const along = uv().x
      const across = abs(centred.y).mul(14)
      profile = exp(across.negate())
        .mul(pow(oneMinus(smoothstep(float(0), float(1), along)), 2))
        .mul(smoothstep(float(0), float(0.04), along))
      colour = mix(
        vec3(0.5, 0.7, 1.7),
        vec3(1.3, 1.35, 1.5),
        exp(along.mul(-6)),
      )
      break
    }
    case 'stretch': {
      /*
       * The hull, drawn out along its own axis — the ship at warp, not a
       * blade left behind it.
       *
       * The reference keeps a recognizable stretching ship as the frame's
       * largest bright mass right through both washes and for five frames
       * after: `subj_w` holds 0.68–0.81 across flash one and 0.90 across
       * flash two, still 0.68 at f2397 and 0.50 at f2402. The two nacelle
       * streaks cannot do that job — they pivot off their anchors and run
       * *away* from the hull, so the mass they make is beside the ship rather
       * than the ship — and the wash cannot either without being the whole
       * frame. So this is a separate element, symmetric about the projected
       * hull, with a hot waist where the hull is and a long axial falloff.
       *
       * Near-neutral in color on purpose, and that is a measurement decision
       * rather than an art one: the subject channel excludes anything whose
       * blue clears red by 90, which is how it keeps credits and the flash's
       * blue field out of the mask. A blue stretch would be light the
       * instrument cannot see a ship in.
       */
      const along = abs(centred.x)
      const across = abs(centred.y)
      const body = exp(along.mul(-2.6)).mul(exp(across.mul(-2.2)))
      const waist = exp(along.mul(-7))
        .mul(exp(across.mul(-4)))
        .mul(0.9)
      profile = body
        .add(waist)
        .mul(oneMinus(smoothstep(float(0.8), float(1), along)))
        .mul(oneMinus(smoothstep(float(0.72), float(1), across)))
      colour = mix(
        vec3(1.1, 1.05, 1.15),
        vec3(0.85, 0.9, 1.2),
        smoothstep(float(0), float(0.85), along),
      )
      break
    }
    case 'spark': {
      /*
       * The anamorphic spike a warp point leaves behind: a vertical needle
       * inside a soft upright halo, with a short cross-bar where the two
       * meet. This is the shape the reference's lens actually produces twice
       * — measured at 0.22 of the frame wide and 0.85 tall at peak — and it
       * is the bridge into both the main title and the end cards, so it is a
       * shape rather than a bloom: a round glow there reads as a star, not as
       * something that just left at warp.
       */
      const nx = abs(centred.x)
      const ny = abs(centred.y)
      /*
       * The needle and the bar are given back the width the quad took away.
       * The quad is 2.6× wider than it was (see `spark.mesh.scale`), because
       * the *halo* is what the subject channel measures and it was less than
       * half the reference's width; scaling the needle's and the bar's own
       * exponents by the same 2.6 keeps them the screen size they already
       * were. Widening all three instead turns the cross-bar into a lens line
       * a third of the frame across, which is the defect this pass is
       * removing everywhere else.
       */
      const needle = exp(nx.mul(-68)).mul(
        pow(oneMinus(smoothstep(float(0), float(1), ny)), 1.6),
      )
      const bar = exp(ny.mul(-30)).mul(
        pow(oneMinus(smoothstep(float(0), float(0.16), nx)), 2),
      )
      const halo = exp(
        length(vec2(centred.x.mul(2.6), centred.y.mul(1.05))).mul(-3.1),
      )
      profile = needle
        .add(bar.mul(0.55))
        .add(halo.mul(0.4))
        .mul(oneMinus(smoothstep(float(0.85), float(1), length(centred))))
      colour = mix(vec3(0.7, 0.85, 1.5), vec3(1.2, 1.2, 1.25), needle)
      break
    }
  }

  const material = new MeshBasicNodeMaterial()
  material.colorNode = colour.mul(profile).mul(intensity).mul(tint)
  material.transparent = true
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = OneFactor
  material.blendDst = OneFactor
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor
  material.depthTest = false
  material.depthWrite = false

  const mesh = new Mesh(quad, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 11
  return { mesh, tint, intensity }
}

// One geometry for every element, like the flare's. Module-level so a Fast
// Refresh re-evaluation reuses it rather than leaking one per edit.
const quad = new PlaneGeometry(1, 1)

export interface WarpEffects {
  readonly group: Group
  update(camera: PerspectiveCamera, view: CinematicView | null): void
  dispose(): void
}

export function createWarpEffects(hullLength: () => number): WarpEffects {
  const group = new Group()
  group.visible = false
  group.renderOrder = 11

  const wash = warpMaterial('wash')
  const glows = [warpMaterial('glow'), warpMaterial('glow')]
  const streaks = [warpMaterial('streak'), warpMaterial('streak')]
  const smear = warpMaterial('streak')
  const spark = warpMaterial('spark')
  const stretch = warpMaterial('stretch')
  // One roster, because it is read twice — added here and disposed below. Two
  // copies of the list is how an element gets created and never disposed, or
  // disposed and never drawn.
  const all = [wash, ...glows, ...streaks, smear, spark, stretch]
  for (const element of all) group.add(element.mesh)

  // Streak quads pivot about their origin end: shift the unit quad so u=0
  // sits on the anchor and scaling stretches away from it.
  for (const element of [...streaks, smear])
    element.mesh.geometry = quad.clone().translate(0.5, 0, 0)

  const projected = new Vector3()
  const world = new Vector3()
  let lastShipX = 0
  let lastShipY = 0
  let hadShip = false
  /*
   * The streak angle, held across a frame the projection cannot answer for.
   *
   * The comment where this is used has always claimed the hold; nothing
   * implemented it. `Vector3.project` on a point behind the lens returns a
   * mirrored NDC rather than an error, so the frames where the nose crosses
   * the camera plane flipped the streaks through a half turn and back.
   */
  let streakAngle = 0

  /** Project a render-space point; returns false when it is behind the lens. */
  const toScreen = (
    camera: PerspectiveCamera,
    x: number,
    y: number,
    z: number,
  ): { x: number; y: number; ok: boolean } => {
    world.set(x, y, z).applyMatrix4(camera.matrixWorldInverse)
    const behind = world.z >= 0
    projected.set(x, y, z).project(camera)
    return { x: projected.x, y: projected.y, ok: !behind }
  }

  return {
    group,
    update(camera, view) {
      if (view === null) {
        group.visible = false
        hadShip = false
        return
      }
      const effects = view.effects
      const anything =
        effects.flash > 0.002 ||
        effects.streaks > 0.002 ||
        effects.nacelleGlow > 0.002 ||
        effects.spark.drive > 0.002 ||
        view.ship.visible
      if (!anything) {
        group.visible = false
        hadShip = false
        return
      }

      group.visible = true
      group.position.copy(camera.position)
      group.quaternion.copy(camera.quaternion)

      // The script's own lens, off the sample that is already in hand. Reading
      // the camera instead would be a second statement of the cinematic angle,
      // in a file with no way to know a script had changed it.
      const tanHalf = Math.tan(verticalFov(view.lens) / 2)
      const aspect = camera.aspect ?? 16 / 9
      const frameHeight = 2 * tanHalf * PLANE
      const place = (mesh: Mesh, nx: number, ny: number): void => {
        mesh.position.set(
          nx * tanHalf * aspect * PLANE,
          ny * tanHalf * PLANE,
          -PLANE,
        )
      }
      // NDC spans −1..1 on both axes while the frame is `aspect` wider than
      // tall, so an on-screen angle needs the x component stretched first.
      const screenAngle = (dx: number, dy: number): number =>
        Math.atan2(dy, dx * aspect)

      const ship = view.ship
      const L = hullLength()
      const shipScreen = toScreen(
        camera,
        ship.position.x,
        ship.position.y,
        ship.position.z,
      )

      // The wash rides the flash envelope, centered on the ship when it is on
      // screen and on the frame when it is not (the second flash peaks after
      // the hull has already streaked out of view).
      const washAnchor = shipScreen.ok
        ? {
            x: Math.max(-0.6, Math.min(0.6, shipScreen.x)),
            y: Math.max(-0.4, Math.min(0.4, shipScreen.y)),
          }
        : { x: 0, y: 0 }
      place(wash.mesh, washAnchor.x, washAnchor.y)
      wash.mesh.scale.set(frameHeight * 4.4, frameHeight * 4.4, 1)
      /*
       * The reference's flash is not a whiteout at all: f1092, its brightest
       * frame, means 100 of 255 across the whole picture — a mid-blue field
       * with a hot core, not a blown one. Driven at 3.5 every channel cleared
       * the tone curve's shoulder together and fifteen frames of the piece
       * rendered as a white rectangle. 0.8 was still twice too hot (a capture
       * meant 176–186 across the peak), and 0.38 against the flat profile
       * above still meant 130–138.
       *
       * This number cannot be arrived at by dividing: `render/tonemap.ts` is
       * ACES with a shoulder, so the whole-frame mean is a saturating function
       * of what is fed to it. The way to it is to model the frame — profile ×
       * color × intensity through the same curve — and check the model against
       * a capture before trusting it. Done that way the model reproduced the
       * measured 130–138 at 0.38/2.2 to within a point, which is what makes
       * its answer here worth acting on.
       */
      wash.intensity.value = effects.flash * 0.46
      wash.tint.value.setRGB(1, 1, 1)

      // Nacelle anchors, projected from hull axes.
      const q = ship.orientation
      const rotate = (v: [number, number, number]): Vector3 => {
        // Quaternion rotate without allocating a THREE.Quaternion per frame.
        const [vx, vy, vz] = v
        const { x: qx, y: qy, z: qz, w: qw } = q
        const ix = qw * vx + qy * vz - qz * vy
        const iy = qw * vy + qz * vx - qx * vz
        const iz = qw * vz + qx * vy - qy * vx
        const iw = -qx * vx - qy * vy - qz * vz
        return world.set(
          ix * qw + iw * -qx + iy * -qz - iz * -qy,
          iy * qw + iw * -qy + iz * -qx - ix * -qz,
          iz * qw + iw * -qz + ix * -qy - iy * -qx,
        )
      }

      // The ship's forward, on screen: the streaks lie along it. When either
      // end of that line is behind the lens the projection is a mirror rather
      // than an answer, so the angle holds from the previous frame — which is
      // invisible over the frame or two the crossing takes, where a half-turn
      // flip is not.
      const forwardWorld = rotate([0, 0, -L])
      const nose = toScreen(
        camera,
        ship.position.x + forwardWorld.x,
        ship.position.y + forwardWorld.y,
        ship.position.z + forwardWorld.z,
      )
      if (nose.ok && shipScreen.ok) {
        streakAngle = screenAngle(shipScreen.x - nose.x, shipScreen.y - nose.y)
      }

      NACELLES.forEach((offset, i) => {
        const glow = glows[i] as WarpElement
        const streak = streaks[i] as WarpElement
        const local = rotate([offset[0] * L, offset[1] * L, offset[2] * L])
        const anchor = toScreen(
          camera,
          ship.position.x + local.x,
          ship.position.y + local.y,
          ship.position.z + local.z,
        )
        const visible = anchor.ok && ship.visible
        place(glow.mesh, anchor.x, anchor.y)
        // The grille glow grows with apparent hull size but is clamped: at
        // occlusion range an unclamped glow would be the whole frame.
        /*
         * A grille, not a lamp. The clamp used to allow a glow half the frame
         * high, and at close range the two of them were the brightest objects
         * in the picture — two white balls in front of a hull the reference
         * renders as lit plating with a slim bright bar along each nacelle.
         * Capped at a fifth of that and started smaller.
         */
        const apparent = Math.min(
          0.42,
          (L * 0.6) / Math.max(distanceTo(camera, ship.position), 1),
        )
        const size = frameHeight * (0.025 + apparent * 0.16)
        glow.mesh.scale.set(size, size, 1)
        glow.intensity.value = visible ? effects.nacelleGlow * 1.5 : 0
        glow.tint.value.setRGB(0.5, 0.75, 1.7)

        place(streak.mesh, anchor.x, anchor.y)
        streak.mesh.rotation.z = streakAngle
        /*
         * Shorter and dimmer than it was, because the stretch below now
         * carries the warp-out's mass. At 0.25 + 2.6 a blade ran 2.85 frame
         * heights — a third longer than the frame's own diagonal — from an
         * anchor that is itself off-center, so what the reference draws as a
         * ship became a lens line across the quadrant with nothing at the
         * ship's own position. Capped at 1.03 frame heights, which is the
         * width of the frame; the light that used to be in the extra two
         * heights is now on the hull instead.
         */
        const streakLength = frameHeight * (0.18 + effects.streaks * 0.85)
        streak.mesh.scale.set(streakLength, frameHeight * 0.055, 1)
        streak.intensity.value =
          visible || effects.streaks > 0.5 ? effects.streaks * 1.3 : 0
        streak.tint.value.setRGB(1, 1, 1)
      })

      /*
       * The warp-out stretch, anchored on the projected hull.
       *
       * Gated on the hull having *collapsed*: a warp-out is the one place the
       * ship shrinks to a point while the streak drive is up, and the same
       * drive fires at each fly-through wipe with the hull filling the frame.
       * Apparent width is what separates them — 0.02–0.5 through the two
       * warp-outs against 0.8 and up through every wipe — so the gate is
       * stateless, which a peak-hold on the hull's size would not have been.
       * (This module is stepped per frame and `ir.seekCutscene` jumps: a trail
       * that remembered how you got to a frame would draw differently on a
       * seek than on a play-through, and the capture loop seeks.)
       *
       * The flash sets the *length* and the streak drive sets the brightness.
       * Both still hold at exactly 1 across the peak — `warpFlashEnvelope`'s
       * `flash` for t 5.5–9 and its `streaks` for t 2–7.5 — so through those
       * frames neither channel can shape anything; what the flash can do is
       * say when the ship is longest, which is the frame the warp point
       * actually forms.
       *
       * The same apparent width, read at the other end of its range, is what
       * ends the residual. The streak envelope decays over 9 frames after the
       * first flash and 15 after the second; the reference's residual is gone
       * in about eight and about twelve. There is nothing left to stretch once
       * the hull is smaller than a pixel, so the bounds are eight
       * ten-thousandths and seven thousandths of the frame: the second
       * warp-out's hull crosses them over f2398–2405, and measured against the
       * reference's own cliff (13.4 at f2397, 8.4 at f2400, 1.2 at f2403) that
       * window's mean error falls from 3.6 to 1.6.
       *
       * The first warp-out now runs this too. It did not when the bounds were
       * metered — `tngIntro.ts`'s titles shot carried no warp-out beats, so
       * the hull froze at w 0.012 from the f1092 cut — and `WARP_OUT_1` fixed
       * that. Nothing here was re-metered against it, so the first exit is the
       * one to look at first when this reads wrong.
       *
       * `aspect` is the window's, not the script's, so these thresholds move
       * with the shape of the browser. They were metered on 16:9.
       */
      const hullWidth = apparentWidth(
        L,
        Math.max(distanceTo(camera, ship.position), 1),
        verticalFovDegrees(view.lens),
        aspect,
      )
      const collapsed = 1 - between(hullWidth, 0.45, 0.95)
      const resolvable = between(hullWidth, 0.0008, 0.007)
      place(stretch.mesh, shipScreen.x, shipScreen.y)
      stretch.mesh.rotation.z = streakAngle
      stretch.mesh.scale.set(
        frameHeight * aspect * (0.58 + effects.flash * 0.52),
        frameHeight * 0.22,
        1,
      )
      stretch.intensity.value =
        shipScreen.ok && ship.visible
          ? effects.streaks ** 1.4 * collapsed * resolvable * 0.85
          : 0
      // A quarter of the frame of additive blend for the ~2,600 frames it is
      // dark: the profile is zero but the fragments are still shaded, and this
      // quad has `depthTest` off and no frustum culling to stop them.
      stretch.mesh.visible = stretch.intensity.value > 0
      stretch.tint.value.setRGB(1, 1, 1)

      /*
       * The spark: screen-anchored, not hull-anchored. It outlives the ship
       * that made it — the reference's first spike peaks eighteen frames after
       * the hull has shrunk past tracking — so it takes its position from the
       * script rather than from a projection, and the anchor is normalized
       * (origin top-left) because that is how the reference was measured.
       */
      const { drive, x: sparkX, y: sparkY } = effects.spark
      place(spark.mesh, sparkX * 2 - 1, 1 - sparkY * 2)
      /*
       * 1.3×: the profile dies before the UV edge, so the quad has to be
       * bigger than the light it carries or the square shows.
       *
       * 0.52 wide, not 0.2. The spike is the one element here whose deficit
       * was pure geometry: measured at its f1129 peak the reference's spike is
       * 0.236 of the frame wide with a mask area of 0.163, the render's was
       * 0.090 and 0.053 — and the ratio of the two areas (3.1) and of the two
       * frame means (2.7) agree, which says the per-pixel brightness was
       * already right and only the width was missing. Widening the quad alone
       * fixes it: the halo's screen aspect goes from 9:1 to 3.5:1, and the
       * reference's own spike measures 0.236 × 0.842 — 3.6:1.
       */
      spark.mesh.scale.set(
        frameHeight * aspect * 0.52 * 1.3,
        frameHeight * 0.86 * 1.3,
        1,
      )
      // 2.05: with the width right, the peak still measured 21.3 against the
      // reference's 25.4 — the spike grows a little harder than
      // `sparkEnvelope` does over its last five frames, and this is the part
      // of that gap a host can close without touching the envelope.
      spark.intensity.value = drive * 2.05
      spark.tint.value.setRGB(1, 1, 1)

      // The smear: apparent-velocity blur for the hull. Anchored on last
      // frame's position, stretched to this frame's — light where the hull
      // was, which is what a long exposure records.
      if (shipScreen.ok && ship.visible && hadShip) {
        const dx = (shipScreen.x - lastShipX) * 0.5 * aspect
        const dy = (shipScreen.y - lastShipY) * 0.5
        const speed = Math.hypot(dx, dy) // screen heights per frame, roughly
        const drive = Math.min(1, speed * 6)
        place(smear.mesh, lastShipX, lastShipY)
        smear.mesh.rotation.z = screenAngle(
          shipScreen.x - lastShipX,
          shipScreen.y - lastShipY,
        )
        const stretch = Math.hypot(
          (shipScreen.x - lastShipX) * tanHalf * aspect * PLANE,
          (shipScreen.y - lastShipY) * tanHalf * PLANE,
        )
        smear.mesh.scale.set(Math.max(stretch, 0.01), frameHeight * 0.12, 1)
        smear.intensity.value = drive * 1.1
        smear.tint.value.setRGB(0.9, 0.95, 1.1)
      } else {
        smear.intensity.value = 0
      }
      if (shipScreen.ok) {
        lastShipX = shipScreen.x
        lastShipY = shipScreen.y
        hadShip = ship.visible
      } else {
        hadShip = false
      }
    },
    dispose() {
      for (const element of all) {
        element.mesh.removeFromParent()
        const material = element.mesh.material
        if (!Array.isArray(material)) material.dispose()
        if (element.mesh.geometry !== quad) element.mesh.geometry.dispose()
      }
    },
  }
}

/**
 * `smooth` in its two-bound form, held outside them.
 *
 * The curve itself is `@inertialref/rendering`'s and stays there — an earlier
 * copy of it here claimed this module could not import that package, which was
 * never true: `preloadPlan.ts` and `atmosphereLuts.ts` next door already do.
 * This is only the change of variable, kept so the two bounds a gate is
 * authored with read as two bounds.
 */
const between = (x: number, a: number, b: number): number =>
  smooth((x - a) / (b - a))

const eye = new Vector3()
function distanceTo(
  camera: PerspectiveCamera,
  p: { x: number; y: number; z: number },
): number {
  return eye.set(p.x, p.y, p.z).distanceTo(camera.position)
}
