import type { Highlight } from './navigator.ts'

/**
 * A string with the matched characters lit.
 *
 * The matcher's ranges are `[start, end, start, end, …]` over the string it
 * matched, end exclusive. Drawn as spans rather than through the library's
 * own `highlight()`, which returns HTML: a designation is catalog data, and
 * the one thing a search box must not do with catalog data is
 * `dangerouslySetInnerHTML` it.
 */
export function Marked({ text, ranges }: Highlight) {
  const parts: { text: string; lit: boolean }[] = []
  let at = 0
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = Math.max(at, ranges[i] ?? at)
    const end = Math.min(text.length, ranges[i + 1] ?? start)
    if (start > at) parts.push({ text: text.slice(at, start), lit: false })
    if (end > start) parts.push({ text: text.slice(start, end), lit: true })
    at = Math.max(at, end)
  }
  if (at < text.length) parts.push({ text: text.slice(at), lit: false })
  return (
    <>
      {parts.map((part, index) =>
        part.lit ? (
          // `text-sky-200` on the run rather than `<mark>`'s yellow: the
          // accent is the interface's own material, and a browser default
          // mark is the one color the palette does not have.
          <span
            key={index}
            className="text-sky-200 underline decoration-sky-500/50 underline-offset-2"
          >
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}
