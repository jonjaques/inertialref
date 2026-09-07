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
const send = (type, x, y) =>
  button.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 41,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  )
send('pointerdown', rect.x + rect.width / 2, rect.y + rect.height / 2)
send('pointermove', innerWidth * 0.48, innerHeight * 0.5)
await settle(6)
const first = engine.harness.observatory.aim
assert(first !== null, 'The first point must acquire ground')
send('pointermove', innerWidth * 0.57, innerHeight * 0.46)
await settle(6)
const preview = engine.harness.observatory.aim
assert(preview !== null, 'The second point must acquire ground')
assert(
  Math.abs(first.longitude - preview.longitude) > 0.01,
  'The drag must change its destination',
)
send('pointerup', innerWidth * 0.57, innerHeight * 0.46)
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
return { preview, landed, error }
