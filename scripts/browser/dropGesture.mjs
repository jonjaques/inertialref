/* Run with scripts/drive.mjs --url http://localhost:5173/planetarium --file scripts/browser/dropGesture.mjs. */
const { document, PointerEvent, requestAnimationFrame, engine, ir } = globalThis
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
const settle = async (count) => {
  for (let index = 0; index < count; index += 1) await frame()
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
ir.pause()
ir.ascend()
await settle(12)
const button = document.querySelector('button[aria-label^="Drag onto"]')
assert(button !== null, 'The drop handle must be available over Earth')
// Synthetic pointer events exercise React's handlers, but cannot establish a
// native active pointer. Only capture is supplied by this fixture.
button.setPointerCapture = () => {}
button.hasPointerCapture = () => false
const rect = button.getBoundingClientRect()
const send = (type, x, y, pointerId = 41) =>
  button.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  )
// Cancel and lost capture must both release the aid without starting a drop.
for (const ending of ['pointercancel', 'lostpointercapture']) {
  send('pointerdown', rect.x + rect.width / 2, rect.y + rect.height / 2)
  send('pointermove', innerWidth * 0.48, innerHeight * 0.5)
  await settle(4)
  assert(
    engine.harness.observatory.aim !== null,
    'Cancellation must exercise a live aim',
  )
  send(ending, innerWidth * 0.48, innerHeight * 0.5)
  await settle(4)
  assert(
    engine.harness.observatory.aim === null,
    'Cancellation must clear the aim',
  )
  assert(
    ir.observerStatus().surface === null,
    'Cancellation must leave the camera in orbit',
  )
}
send('pointerdown', rect.x + rect.width / 2, rect.y + rect.height / 2)
send('pointermove', innerWidth * 0.48, innerHeight * 0.5)
await settle(6)
const first = engine.harness.observatory.aim
send('pointermove', innerWidth * 0.8, innerHeight * 0.8, 42)
send('pointerup', innerWidth * 0.8, innerHeight * 0.8, 42)
await settle(4)
assert(
  ir.observerStatus().surface === null,
  'A second pointer must not commit the drag',
)
assert(
  engine.harness.observatory.aim?.longitude === first?.longitude,
  'A second pointer must not move the held end',
)
assert(first !== null, 'The first point must acquire ground')
const pointer = globalThis.dropPointer ?? {
  x: innerWidth * 0.57,
  y: innerHeight * 0.46,
}
send('pointermove', pointer.x, pointer.y)
await settle(6)
const preview = engine.harness.observatory.aim
assert(preview !== null, 'The second point must acquire ground')
assert(
  Math.abs(first.longitude - preview.longitude) > 0.01,
  'The drag must change its destination',
)
// Project the scene's held endpoint back through the real camera. This proves
// attachment in pixels, independently of the adapter that unprojects the hand.
const scene = engine.scene()
const drawn = scene.bodies.find(
  (body) => body.address === engine.harness.observatory.target.address,
)
const held = preview.launch[0]
const projected = engine.view.camera.position
  .clone()
  .set(held.x, held.y, held.z)
projected.multiplyScalar(drawn.placement.scale)
projected.applyQuaternion(drawn.orientation)
projected.add(drawn.placement.position).project(engine.view.camera)
const pointerError = Math.hypot(
  ((projected.x + 1) * innerWidth) / 2 - pointer.x,
  ((1 - projected.y) * innerHeight) / 2 - pointer.y,
)
assert(
  pointerError < 0.01,
  `The held endpoint misses the pointer by ${pointerError} pixels`,
)
if (globalThis.dropGestureHold)
  return {
    pointer,
    pointerError,
    latitude: preview.latitude,
    longitude: preview.longitude,
  }
send('pointerup', pointer.x, pointer.y)
// Complete the actual camera arm without waiting eight wall-clock seconds.
for (let index = 0; index < 600; index += 1) ir.observerSample(1 / 60)
const landed = ir.observerStatus()?.surface?.stance
assert(landed !== undefined, 'Releasing must start a drop')
const error = Math.hypot(
  landed.latitude - preview.latitude,
  landed.longitude - preview.longitude,
)
assert(
  error < 1e-9,
  `Landing differs from the last preview by ${error} radians`,
)
return {
  preview: { latitude: preview.latitude, longitude: preview.longitude },
  landed,
  error,
  pointerError,
}
