import {
  AddEquation,
  BackSide,
  CustomBlending,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  SphereGeometry,
  Vector2,
  Vector3,
  ZeroFactor,
} from 'three/webgpu'
import {
  abs,
  cos,
  dot,
  exp,
  float,
  mix,
  normalView,
  positionView,
  positionLocal,
  pow,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl'
import { Quaternion as Q, Vec, type Vec3 } from '@inertialref/spatial'
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

/** The authored surface sky, heated flow around the hull, and lifted pad dust. */
export function createLandingEffects() {
  const group = new Group()
  group.name = 'landing-effects'
  const heat = uniform(0)
  const dust = uniform(0)
  const seconds = uniform(0)
  const haze = uniform(0)
  const sunward = uniform(new Vector3(0, 0, -1))
  const sunGlow = uniform(0)
  const skyMaterial = sensorRadiance(new MeshBasicNodeMaterial(), true)
  skyMaterial.side = BackSide
  skyMaterial.depthWrite = false
  skyMaterial.depthNode = float(1)
  skyMaterial.fog = false
  const elevation = positionLocal.normalize().y
  const rose = mix(
    vec3(0.27, 0.105, 0.042),
    vec3(0.074, 0.027, 0.041),
    smoothstep(0.015, 0.35, elevation),
  )
  const upper = mix(
    rose,
    vec3(0.017, 0.011, 0.022),
    smoothstep(0.15, 0.92, elevation),
  )
  const sunAngle = dot(positionLocal.normalize(), sunward)
  const solarGlow = exp(sunAngle.sub(1).mul(18))
    .mul(0.6)
    .add(exp(sunAngle.sub(1).mul(200)).mul(0.35))
    .mul(sunGlow)
  skyMaterial.colorNode = mix(
    vec3(0.11, 0.046, 0.026),
    upper,
    smoothstep(-0.4, 0, elevation),
  )
    .add(vec3(0.55, 0.22, 0.072).mul(solarGlow))
    .mul(haze)
  const sky = new Mesh(new SphereGeometry(1000, 48, 32), skyMaterial)
  sky.name = 'cinematic-sky'
  // The galaxy draws first. A far-depth sky without a depth write leaves
  // opaque terrain and the hull in front under either draw-order policy.
  sky.renderOrder = -900
  sky.frustumCulled = false
  group.add(sky)

  const entryMaterial = effectMaterial(true)
  const along = uv().y
  const around = uv().x.mul(Math.PI * 2)
  const curl = sin(around.mul(3).sub(seconds.mul(1.7)))
    .mul(1.1)
    .add(sin(around.mul(7).add(seconds.mul(0.8))).mul(0.45))
  const stream = sin(
    around.mul(11).add(curl).add(along.mul(5)).sub(seconds.mul(19)),
  )
    .mul(0.5)
    .add(0.5)
  const broken = sin(around.mul(5).add(along.mul(19)).sub(seconds.mul(9)))
    .mul(0.23)
    .add(sin(around.mul(2).sub(along.mul(11)).add(seconds.mul(4))).mul(0.22))
    .add(0.55)
  const filament = pow(stream, 4).mul(smoothstep(0.25, 0.85, broken))
  const turbulence = sin(around.mul(7).sub(seconds.mul(13)).add(along.mul(41)))
    .mul(0.18)
    .add(sin(around.mul(3).add(along.mul(13)).sub(seconds.mul(7))).mul(0.2))
    .add(0.62)
  const facing = abs(normalView.dot(positionView.negate().normalize()))
  const rim = float(1).sub(facing).pow(2).mul(0.94).add(0.025)
  const shoulder = exp(along.sub(0.24).pow(2).mul(-70))
  const tail = float(1).sub(smoothstep(0.3, 1, along))
  const edge = smoothstep(0, 0.055, along).mul(
    float(1).sub(smoothstep(0.84, 1, along)),
  )
  entryMaterial.colorNode = mix(
    vec3(1.15, 0.16, 0.025),
    vec3(1.9, 0.95, 0.35),
    shoulder,
  )
    .mul(shoulder.mul(0.55).add(filament.mul(tail).mul(0.34)))
    .mul(turbulence)
    .mul(rim)
    .mul(edge)
    .mul(heat)
    .mul(2.5)
  // Lathe Y points toward hull −Z, opposite the tail-first entry. The open
  // waist leaves the armor visible; a closed sphere hides the hull.
  const entry = new Mesh(
    new LatheGeometry(
      [
        new Vector2(0.015, -0.565),
        new Vector2(0.16, -0.555),
        new Vector2(0.34, -0.515),
        new Vector2(0.46, -0.445),
        new Vector2(0.53, -0.34),
        new Vector2(0.56, -0.2),
        new Vector2(0.61, 0),
        new Vector2(0.67, 0.25),
        new Vector2(0.72, 0.6),
        new Vector2(0.82, 1.15),
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
    update(
      view: CinematicView | null,
      lengthMetres = 46,
      beamMetres = 16,
      sunPosition?: Vec3,
    ) {
      const heating =
        view?.ship.visible === true ? (view.effects.entryHeat ?? 0) : 0
      const lifting =
        view?.stage === undefined ? 0 : (view.effects.landingDust ?? 0)
      const skyDrive =
        view?.stage === undefined ? 0 : (view.effects.skyHaze ?? 0)
      group.visible = heating > 0 || lifting > 0 || skyDrive > 0
      sky.visible = skyDrive > 0
      haze.value = Math.max(0, Math.min(1, skyDrive))
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
        sunGlow.value = sunPosition === undefined ? 0 : 1
        if (sunPosition !== undefined) {
          const direction = Q.rotateInverse(
            stage.orientation,
            Vec.normalize(Vec.sub(sunPosition, view.camera.position)),
          )
          sunward.value.set(direction.x, direction.y, direction.z)
        }
        sky.position.set(
          view.camera.position.x,
          view.camera.position.y,
          view.camera.position.z,
        )
        sky.quaternion.set(
          stage.orientation.x,
          stage.orientation.y,
          stage.orientation.z,
          stage.orientation.w,
        )
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
      sky.geometry.dispose()
      skyMaterial.dispose()
      entry.geometry.dispose()
      entryMaterial.dispose()
      dustCloud.geometry.dispose()
      dustMaterial.dispose()
    },
  }
}
