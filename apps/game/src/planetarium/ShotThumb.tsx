/**
 * What a shot looks like, drawn rather than named.
 *
 * The panel this replaced had two lists of word-buttons — `Close · Portrait ·
 * Wide` and `Blue Marble · Raking · Earthrise · Backlit · High Angle · First
 * Light` — and there was no way to tell from either of them what would happen.
 * Nine identical rectangles of type, and the only two things that separate a
 * shot from its neighbour are *how much of the frame the body fills* and *where
 * the terminator falls*, both of which are pictures. So they are drawn.
 *
 * The geometry is the real geometry rather than an illustrator's guess:
 *
 *   the disk    `fill` is the fraction of the frame's **height** the body
 *               subtends, which is exactly what `frameTarget` solves a distance
 *               for. So the radius here is `fill × halfHeight` and the thumbnail
 *               is to scale with the frame it is predicting.
 *   the light   the terminator is the projection of the day–night circle, and
 *               its projected half-width is `r·cos(phase)`. That is why the lit
 *               shape is a semicircle plus a half-*ellipse* and not two arcs of
 *               the same radius: at 90° the ellipse collapses to a straight
 *               line, which is what half phase is.
 *
 * The lit limb is on the right in every one of them, matching the phase glyphs
 * in `icons/index.tsx` and matching `anglesForPhase`, whose azimuth runs from
 * the sun line.
 */
export function ShotThumb({
  phase,
  tilt,
  fill,
}: {
  /** Sun–body–camera angle in degrees. 0 is full face, 180 is behind. */
  phase: number
  /** How far the swing plane is rolled out of the star's own, degrees. */
  tilt: number
  /** Fraction of the frame height the body fills. */
  fill: number
}) {
  const width = 64
  const height = 36
  const cx = width / 2
  const cy = height / 2
  const r = Math.max(1.2, fill * (height / 2))
  const radians = (phase * Math.PI) / 180
  /*
   * The terminator's projected half-width, and which side it bulges to.
   *
   * `cos φ > 0` puts the apex left of centre — more than half the disk is lit,
   * which is gibbous. `cos φ < 0` puts it right, which is a crescent. The sweep
   * flag follows from that and nothing else: an arc from the bottom of the disk
   * to the top is clockwise in SVG's y-down space when it passes on the left.
   */
  const cosine = Math.cos(radians)
  const rx = Math.abs(cosine) * r
  const sweep = cosine > 0 ? 1 : 0
  const lit = `M ${cx} ${cy - r} A ${r} ${r} 0 0 1 ${cx} ${cy + r} A ${rx} ${r} 0 0 ${sweep} ${cx} ${cy - r} Z`
  /*
   * A third of the tilt, as a roll of the whole picture.
   *
   * Tilt is how far the camera's swing plane is rolled out of the star's, and
   * on screen its effect is that the terminator is not vertical. A third rather
   * than the angle itself because the two only coincide at phase 90 — at phase
   * 10 a 60° tilt barely moves the terminator at all — and a thumbnail that
   * rolled the full amount would promise a picture the solver does not produce.
   */
  const roll = -tilt / 3

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className="block w-full rounded-sm"
    >
      <rect width={width} height={height} className="fill-slate-950/80" />
      {/* The unlit body: present, and only just. A shot at 172° is a disk you
          can see the *shape* of against the sky and almost nothing else, and a
          thumbnail that drew nothing there would look like an empty frame. */}
      <circle cx={cx} cy={cy} r={r} className="fill-slate-800/70" />
      {/* The airglow, and only where there is enough of it to be the picture.
          Past 150° the atmosphere ringing the dark limb is the whole subject —
          `PhaseRim` in `icons/index.tsx` makes the same argument about why that
          composition cannot be drawn to the same recipe as the other four. */}
      {phase > 150 && (
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          strokeWidth={1}
          className="stroke-sky-300/70"
        />
      )}
      <path
        d={lit}
        transform={`rotate(${roll} ${cx} ${cy})`}
        className="fill-slate-200"
      />
    </svg>
  )
}
