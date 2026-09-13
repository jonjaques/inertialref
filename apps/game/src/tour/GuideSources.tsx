import type { TourSource } from '@inertialref/protocol'

export function GuideSources({ sources }: { sources: readonly TourSource[] }) {
  if (sources.length === 0) return null
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Sources">
      {sources.map((source) => (
        <li
          key={source.id}
          className="type-micro rounded border border-slate-700/70 px-2 py-1.5 text-slate-400"
        >
          {source.url !== null && /^https:\/\//.test(source.url) ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="text-sky-300 underline underline-offset-2"
            >
              {source.title}
            </a>
          ) : (
            source.title
          )}
          <span className="block">
            {source.origin === 'curated' ? 'Astronomy source' : 'Object record'}
          </span>
        </li>
      ))}
    </ul>
  )
}
