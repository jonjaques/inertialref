import { licenseOf, SOUNDTRACK_CATEGORY_TITLES } from '@inertialref/protocol'
import { CATEGORIES_PRESENT, SOUNDTRACK } from '../audio/catalog.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { SITE } from '../site.ts'
import { OverlayPage } from './OverlayPage.tsx'

/*
 * Who made the music, and under what license.
 *
 * **The credit is the licensor's own words.** Each entry is the line the
 * catalog carries, which `apps/ingest` builds from the credit the licensor
 * asked for and the change this build made — CC BY wants the work, the
 * creator, the license and what was modified, and the line has all four — so
 * nothing here paraphrases what somebody else asked to be called. Under it, a
 * link to the license and one to where the track came from, which is the
 * "reasonably practicable" URI the license asks for.
 *
 * CC0 and public-domain tracks are credited the same way. Nothing obliges it;
 * leaving them out would make the page a list of obligations rather than of
 * the people whose music this is.
 *
 * A dialog with an address, like About: a credit somebody can link to is the
 * one a licensor can check.
 */

const LINK = `rounded text-sky-300 underline-offset-2 hover:text-sky-200 hover:underline ${FOCUS_RING}`

export function CreditsPage() {
  return (
    <OverlayPage title="Credits" subtitle="The soundtrack, and who made it">
      <div className="flex flex-col gap-4">
        <p className="text-pretty text-slate-300">
          The music in the Planetarium is the work of the artists below, each
          under the license beside it. Every file the game plays was changed
          from its source in the way its entry says; the sources themselves are
          kept unmodified in the{' '}
          <a
            href={`${SITE.repository}/tree/main/data/audio`}
            target="_blank"
            rel="noreferrer"
            className={LINK}
          >
            repository
          </a>
          , with where each one came from.
        </p>

        {CATEGORIES_PRESENT.map((category) => (
          <section
            key={category}
            aria-labelledby={`credits-${category}`}
            className="flex flex-col gap-2"
          >
            <h2
              id={`credits-${category}`}
              className="type-label text-sky-400/80"
            >
              {SOUNDTRACK_CATEGORY_TITLES[category].title}
            </h2>
            <ul className="flex flex-col gap-2.5">
              {SOUNDTRACK.tracks
                .filter((track) => track.category === category)
                .map((track) => {
                  const license = licenseOf(track)
                  return (
                    <li
                      key={track.id}
                      className="flex flex-col gap-0.5 border-l border-slate-800 pl-3"
                    >
                      <p className="text-pretty text-slate-300">
                        {track.credit}
                      </p>
                      <p className="type-ui flex flex-wrap gap-x-3 text-slate-400">
                        <a
                          href={license.url}
                          target="_blank"
                          rel="noreferrer license"
                          className={LINK}
                        >
                          {license.name}
                        </a>
                        <a
                          href={track.licensor}
                          target="_blank"
                          rel="noreferrer"
                          className={LINK}
                        >
                          Source
                        </a>
                      </p>
                    </li>
                  )
                })}
            </ul>
          </section>
        ))}

        {CATEGORIES_PRESENT.includes('signals') && (
          <p className="type-ui text-pretty text-slate-400">
            The spacecraft recordings are NASA’s, used under its media
            guidelines. NASA does not endorse this project.
          </p>
        )}
      </div>
    </OverlayPage>
  )
}
