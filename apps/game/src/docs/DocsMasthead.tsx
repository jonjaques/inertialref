import { motion } from 'motion/react'
import type { DocCounts, DocPage, DocWing } from './content.ts'
import { DOCS } from '../pages/paths.ts'

/**
 * The title, over the sky.
 *
 * The continuation of the horizon above it — same picture, nineteen rem of it,
 * and this half scrolls away. What sits on it is a title and a sentence, and
 * deliberately nothing else: no label above the heading naming the wing, which
 * is what the bar's breadcrumb and the rail are already for. A heading that
 * needs a word above it to be understood is a heading that has not been written
 * yet.
 *
 * The gradient is the same measurement the front door makes. A column of type
 * over a sunlit limb needs a ground, and the ground has to stop before the
 * picture does — this one is gone by two thirds of the width, so the right of
 * the band is the scene and the left is a poster.
 */
export function DocsMasthead({
  wing,
  page,
  route,
  counts,
  pending,
}: {
  wing: DocWing | undefined
  page: DocPage | null
  route: string
  counts: DocCounts | null
  pending: boolean
}) {
  const front = route === DOCS
  const title = page?.title ?? (pending ? '' : 'Not Found')
  /*
   * A sentence under the title on the section's front page, and on no other.
   *
   * It was the document's own lead everywhere, which reads well in a search
   * result and badly on the page it came from: `concepts/coordinates` opened
   * with "InertialRef has to place a bolt on a hull and a star at the far rim
   * of the galaxy in the same universe" in the masthead and again eight lines
   * below it, in the article, where the author put it. A masthead that
   * paraphrases the first paragraph is a masthead the reader has to read twice.
   *
   * The front page has no first paragraph of its own to collide with, and the
   * wing's blurb is the one line nothing else on screen says.
   */
  const lead = front ? (wing?.blurb ?? '') : ''

  /* Shorter on a phone, where the band is a third of the screen rather than a
     quarter of it, and the top of it is empty sky above a title that has
     nowhere else to go. */
  return (
    <header className="relative flex h-44 items-end overflow-hidden sm:h-64">
      {/* A radial scrim under the type, reaching zero in every direction.
          `index.css` carries the stops and the contrast measurement; the short
          version is that a linear scrim down the left edge is at full strength
          at the top of the band, which is where the limb and the flare are. */}
      <div className="doc-masthead-scrim pointer-events-none absolute inset-0" />
      {/* And a shallow one downward, because the reading plate begins
          immediately under this and a hard edge between a photograph and a
          panel reads as a seam rather than as an edge. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-slate-950/85 to-transparent" />
      <motion.div
        key={route}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="doc-measure relative w-full pb-7"
      >
        <h1 className="type-display text-[clamp(2.25rem,4.4vw,3.5rem)] text-balance text-slate-50">
          {title}
        </h1>
        {lead !== '' && (
          <p className="type-body mt-3 max-w-[46ch] text-slate-300">{lead}</p>
        )}
        {/*
         * How much of it there is, on the front page only, as figures.
         *
         * The same move the menu makes with `7,123` and `150 ly`, for the same
         * reason: these are counts of what is actually in this build, taken
         * from the manifest the page is reading, and a monospaced figure reads
         * as a measurement where a sentence containing it reads as a boast.
         * They also answer the question a stranger opening a documentation site
         * actually has, which is whether there is anything in it.
         */}
        {front && counts !== null && (
          <dl className="mt-5 flex max-w-[40rem] flex-wrap items-baseline gap-x-7 gap-y-2 border-t border-slate-800 pt-4">
            {[
              [counts.words.toLocaleString('en-US'), 'Words'],
              [String(counts.diagrams), 'Diagrams'],
              [counts.exports.toLocaleString('en-US'), 'Exports'],
            ].map(([figure, what]) => (
              <div key={what} className="flex items-baseline gap-2">
                <dt className="type-figure text-sky-200">{figure}</dt>
                <dd className="type-label text-slate-400">{what}</dd>
              </div>
            ))}
          </dl>
        )}
      </motion.div>
    </header>
  )
}
