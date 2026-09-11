import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  Vector2,
  ZeroFactor,
} from 'three/webgpu'
import {
  abs,
  cos,
  exp,
  float,
  mix,
  normalView,
  positionView,
  pow,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl'
import type { CinematicView } from '../engine/GameEngine.ts'
import { sensorRadiance } from './radiance.ts'

function effectMaterial(additive: boolean): MeshBasicNodeMaterial {
  const material = sensorRadiance(new MeshBasicNodeMaterial(), true)
  material.transparent = true
  material.depthWrite = false
  material.side = DoubleSide
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = additive ? OneFactor : SrcAlphaFactor
  material.blendDst = additive ? OneFactor : OneMinusSrcAlphaFactor
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor
  return material
}

/** Two open shells: the heated flow around the hull and dust over the deck. */
export function createLandingEffects() {
  const group = new Group()
  group.name = 'landing-effects'
  const heat = uniform(0)
  const dust = uniform(0)
  const seconds = uniform(0)

  const entryMaterial = effectMaterial(true)
  const along = uv().y
  const around = uv().x.mul(Math.PI * 2)
  const filament = pow(
    sin(around.mul(17).add(along.mul(9)).sub(seconds.mul(22)))
      .mul(0.5)
      .add(0.5),
    9,
  )
  const turbulence = sin(around.mul(7).sub(seconds.mul(13)).add(along.mul(41)))
    .mul(0.18)
    .add(0.82)
  const facing = abs(normalView.dot(positionView.negate().normalize()))
  const rim = float(1).sub(facing).pow(2.2).mul(0.88).add(0.035)
  const shoulder = exp(along.sub(0.2).pow(2).mul(-95))
  const tail = float(1).sub(smoothstep(0.3, 1, along))
  const edge = smoothstep(0, 0.055, along).mul(
    float(1).sub(smoothstep(0.84, 1, along)),
  )
  entryMaterial.colorNode = mix(
    vec3(1.15, 0.16, 0.025),
    vec3(1.9, 0.95, 0.35),
    shoulder,
  )
    .mul(shoulder.mul(0.55).add(filament.mul(tail).mul(0.7)))
    .mul(turbulence)
    .mul(rim)
    .mul(edge)
    .mul(heat)
    .mul(2.5)
  // Lathe Y points toward hull −Z, opposite the tail-first entry. The open waist leaves the armor visible while
  // the grazing rim reads as a shock layer; a closed sphere hides the hull.
  const entry = new Mesh(
    new LatheGeometry(
      [
        new Vector2(0.015, -0.57),
        new Vector2(0.22, -0.52),
        new Vector2(0.52, -0.37),
        new Vector2(0.62, -0.12),
        new Vector2(0.69, 0.25),
        new Vector2(0.84, 0.9),
      ],
      64,
    ),
    entryMaterial,
  )
  entry.rotation.x = -Math.PI / 2
  entry.name = 'entry-sheath'
  entry.renderOrder = 11
  entry.frustumCulled = false
  const entryPose = new Group()
  entryPose.name = 'entry-pose'
  entryPose.add(entry)
  group.add(entryPose)

  const dustMaterial = effectMaterial(false)
  const r = uv().y
  const billows = sin(around.mul(9).add(r.mul(27)).sub(seconds.mul(2.5)))
    .mul(0.25)
    .add(cos(around.mul(17).sub(r.mul(31)).add(seconds.mul(1.7))).mul(0.15))
    .add(0.6)
  const radialFade = smoothstep(0, 0.16, r).mul(
    float(1).sub(smoothstep(0.35, 1, r)),
  )
  dustMaterial.colorNode = mix(
    vec3(0.14, 0.063, 0.026),
    vec3(0.4, 0.23, 0.1),
    billows,
  )
  dustMaterial.opacityNode = billows.mul(radialFade).mul(dust).mul(0.48)
  const dustCloud = new Mesh(
    new LatheGeometry(
      [
        new Vector2(12, 0.35),
        new Vector2(22, 2.4),
        new Vector2(34, 4),
        new Vector2(49, 3.1),
        new Vector2(69, 1.7),
        new Vector2(95, 0.35),
      ],
      80,
    ),
    dustMaterial,
  )
  dustCloud.name = 'pad-dust'
  dustCloud.renderOrder = 12
  dustCloud.frustumCulled = false
  const dustPose = new Group()
  dustPose.name = 'dust-pose'
  dustPose.add(dustCloud)
  group.add(dustPose)
  group.visible = false

  return {
    group,
    update(view: CinematicView | null, lengthMetres = 46, beamMetres = 16) {
      const heating =
        view?.ship.visible === true ? (view.effects.entryHeat ?? 0) : 0
      const lifting =
        view?.stage === undefined ? 0 : (view.effects.landingDust ?? 0)
      group.visible = heating > 0 || lifting > 0
      entryPose.visible = heating > 0
      dustPose.visible = lifting > 0
      heat.value = Math.max(0, Math.min(1, heating))
      dust.value = Math.max(0, Math.min(1, lifting))
      seconds.value = view?.elapsedSeconds ?? 0
      if (view === null) return
      const ship = view.ship
      entryPose.position.set(ship.position.x, ship.position.y, ship.position.z)
      entryPose.quaternion.set(
        ship.orientation.x,
        ship.orientation.y,
        ship.orientation.z,
        ship.orientation.w,
      )
      entry.scale.set(beamMetres, lengthMetres, beamMetres)
      const stage = view.stage
      if (stage !== undefined) {
        dustPose.position.set(
          stage.position.x,
          stage.position.y,
          stage.position.z,
        )
        dustPose.quaternion.set(
          stage.orientation.x,
          stage.orientation.y,
          stage.orientation.z,
          stage.orientation.w,
        )
        const spread = 0.6 + 0.4 * dust.value
        dustCloud.scale.set(spread, 0.65 + 0.35 * dust.value, spread)
      }
    },
    dispose() {
      entry.geometry.dispose()
      entryMaterial.dispose()
      dustCloud.geometry.dispose()
      dustMaterial.dispose()
    },
  }
}
