/**
 * Consecutive-frame difference, and the frames that stand alone.
 *
 * A still cannot show a strobe, and neither can `--shot`:
 * `Page.captureScreenshot` draws its own frame, so a periodic one-frame artifact
 * is exactly what it never catches. What catches it is a run of *rendered*
 * frames — a screencast, or the screenshots a Chrome performance trace already
 * carries — differenced against each other.
 *
 * The signal that matters is not "how much changed". It is **a frame that
 * differs from both of its neighbours while those neighbours are identical to
 * each other**. That shape says the scene is static and one frame departed from
 * it, which is a strobe; anything genuinely moving makes every consecutive pair
 * differ and leaves no isolated frame at all. The lunar terrain strobe was found
 * exactly this way — frames 25 and 27 differed by zero pixels, frame 26 differed
 * from both by 30,050, once every 26 frames.
 *
 * ImageMagick rather than a decode-in-process library: it is already how every
 * picture in this repository gets compared by hand, `-auto-level` over a
 * difference composite is the one command that answers *where* a frame changed,
 * and keeping the script and the shell on the same tool means a surprising
 * number can be re-run by pasting it.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Long edge the comparison runs at. Keeps a horizon; drops JPEG ringing. */
const COMPARE_PX = 480
/** Per-pixel difference below which two frames are the same pixel. */
const SAME = '3%'

/**
 * The downscale is not a shortcut.
 *
 * At native size a screencast of a starfield differs from itself by a dozen
 * pixels a frame — compression ringing, and stars that are one device pixel
 * wide sitting on a subpixel boundary. Both average out at 480 px and neither
 * has to be subtracted by eye from every row of the series.
 */
const RESIZE = ['-resize', `${COMPARE_PX}x${COMPARE_PX}`]

async function magick(args) {
  try {
    const { stdout } = await run('magick', args, { maxBuffer: 1 << 24 })
    return stdout.trim()
  } catch (cause) {
    throw new Error(
      `ImageMagick failed — is \`magick\` on PATH? (${String(cause)})`,
    )
  }
}

/** Pixels that differ between two frames, at the comparison size. */
const changed = async (a, b) =>
  Number(
    await magick([
      a,
      b,
      ...RESIZE,
      '-compose',
      'difference',
      '-composite',
      '-colorspace',
      'Gray',
      '-threshold',
      SAME,
      '-format',
      '%[fx:int(mean*w*h+0.5)]',
      'info:',
    ]),
  )

/**
 * Where two frames differ, amplified, as an image.
 *
 * `-auto-level` is the point: a collapse that moves the ground by one level is
 * a few counts per pixel over a wide area, which is invisible in a raw
 * difference and unmistakable once stretched.
 */
export const differenceMap = async (a, b, out) => {
  await magick([
    a,
    b,
    '-compose',
    'difference',
    '-composite',
    '-colorspace',
    'Gray',
    '-auto-level',
    out,
  ])
  return out
}

const median = (values) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/**
 * Difference a run of frames and name the ones that stand alone.
 *
 * `timestamps` are seconds and optional; with them the report carries the rate
 * a strobe recurs at, which is the unit a bug report is written in — "two or
 * three times a second" — and the one no frame index can be compared against.
 */
export async function analyseFrames(paths, timestamps = null) {
  const pairs = []
  for (let i = 1; i < paths.length; i += 1)
    pairs.push(await changed(paths[i - 1], paths[i]))

  /*
   * A floor rather than a multiple alone. On a perfectly static scene the
   * median pair is zero, and six times zero admits every stray pixel as a
   * spike; on a busy one the median carries the noise and the multiple is what
   * clears it. Whichever is larger is the honest threshold.
   */
  const floor = Math.max(median(pairs) * 6, 200)

  const isolated = []
  for (let i = 1; i < paths.length - 1; i += 1) {
    if (pairs[i - 1] <= floor || pairs[i] <= floor) continue
    // The skip comparison is the whole test. Without it every frame of a
    // moving camera reads as a spike; with it, a moving camera produces none.
    const skip = await changed(paths[i - 1], paths[i + 1])
    if (skip * 4 < pairs[i - 1])
      isolated.push({ frame: i, changed: pairs[i - 1], skip })
  }

  /*
   * One disturbance is not one frame.
   *
   * The terrain collapse arrives as a large departure with a smaller one three
   * frames behind it — the disk dropping to a coarse level, then the level
   * under it arriving — so the raw gaps alternate 3, 23, 3, 23 and their median
   * is a period at which nothing happens. Isolated frames closer together than
   * this belong to one event, and it is the events that recur.
   */
  const TOGETHER = 5
  const events = []
  for (const one of isolated) {
    const last = events[events.length - 1]
    if (last !== undefined && one.frame - last.frame <= TOGETHER) continue
    events.push(one)
  }

  let hz = null
  let period = null
  if (events.length > 1) {
    const gaps = []
    for (let i = 1; i < events.length; i += 1)
      gaps.push(events[i].frame - events[i - 1].frame)
    period = median(gaps)
    if (timestamps !== null && timestamps.length === paths.length) {
      const seconds = []
      for (let i = 1; i < events.length; i += 1)
        seconds.push(
          timestamps[events[i].frame] - timestamps[events[i - 1].frame],
        )
      const mean = seconds.reduce((a, b) => a + b, 0) / seconds.length
      if (mean > 0) hz = 1 / mean
    }
  }

  return {
    frames: paths.length,
    pairs,
    quiet: median(pairs),
    isolated,
    events,
    period,
    hz,
  }
}

/**
 * Below this the capture is subsampling the page and a clean run means nothing.
 *
 * A one-frame artifact on a 26-frame period survives a 60 fps capture and is a
 * coin toss at 18, which is what a PNG screencast of a retina buffer delivers.
 * A quiet result at a low rate has to say so rather than read as an all-clear —
 * this exact false negative cost an hour before the rate was measured at all.
 */
const TRUSTWORTHY_FPS = 40

/** One block of prose for a terminal, because the series alone is unreadable. */
export function reportFrames(analysis, fps = null) {
  const lines = [`frames ${analysis.frames}, quiet pair ${analysis.quiet} px`]
  const subsampled =
    fps !== null && fps > 0 && fps < TRUSTWORTHY_FPS
      ? ` — and ${fps.toFixed(1)} fps is subsampling the page, so this is not an all-clear`
      : ''
  if (analysis.isolated.length === 0) {
    lines.push(
      `no isolated frames — nothing strobes, or the camera is moving and this cannot tell${subsampled}`,
    )
    return lines.join('\n')
  }
  const rate = analysis.hz === null ? '' : ` — ${analysis.hz.toFixed(2)} Hz`
  lines.push(
    `${analysis.events.length} events over ${analysis.isolated.length} isolated frames, ` +
      `every ${analysis.period ?? '?'} frames${rate}`,
  )
  for (const one of analysis.events.slice(0, 6))
    lines.push(
      `  frame ${one.frame}: ${one.changed} px against its neighbours, ${one.skip} px between them`,
    )
  if (analysis.events.length > 6)
    lines.push(`  …and ${analysis.events.length - 6} more`)
  return lines.join('\n')
}
