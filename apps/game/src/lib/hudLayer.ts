/**
 * Where a registry popup is portalled, and why it is not `document.body`.
 *
 * `.hud-layer` carries `dynamic-range-limit: standard` and that property
 * inherits, so anything drawn outside it is composited at whatever range the
 * canvas is running — which for a `backdrop-blur` chip over a star is twice
 * diffuse white. Read per render rather than held: `App` owns the layer for the
 * life of the session, but the element is replaced whenever the tree remounts,
 * and a stale node is a popup nobody can see. `null` is a legal container and
 * means the body, which is the right answer for a boot-time failure panel that
 * has no layer to sit in.
 *
 * The popup is `position: fixed` under Radix, so the layer's offsets — the safe
 * areas, an attached menu's band — do not move it.
 */
export const hudLayer = (): HTMLElement | null =>
  typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLElement>('.hud-layer')
