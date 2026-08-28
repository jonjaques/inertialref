import { useEffect, useState } from 'react'
import type { DocPage } from './content.ts'

/**
 * On this page.
 *
 * Two levels, because `scripts/docs/markdown.mjs` only sends two: a `####` in
 * this corpus is a sub-point inside a section rather than a place to jump to,
 * and listing every one turns a rail you can scan into a second copy of the
 * document.
 *
 * The highlight follows the scroll through an `IntersectionObserver` rather
 * than a scroll handler. A scroll handler on a container this long is a
 * measurement per frame of every heading's position; the observer is told once
 * and answers when a heading crosses a line. The line is set by `rootMargin` —
 * a hundred pixels down from the top, so a heading counts as "the section you
 * are in" from the moment it clears the sticky bar rather than when it is
 * halfway up the screen.
 *
 * It observes against the viewport rather than the scroller, which is the same
 * answer here: the scroller fills the window below a three-rem strip, so a
 * heading's position in one is its position in the other, and taking the
 * viewport means this component does not need a reference to a box two
 * ancestors up.
 */
export function DocContents({ page }: { page: DocPage | null }) {
  const [active, setActive] = useState<string | null>(null)
  const headings = page?.headings ?? []
  const html = page?.html ?? null

  useEffect(() => {
    if (html === null) return
    const targets = [
      ...document.querySelectorAll<HTMLElement>('.doc-prose [id]'),
    ]
    if (targets.length === 0) return

    // The set of headings currently inside the band, kept rather than
    // recomputed: an observer callback carries only what *changed*, so
    // answering "which is topmost now" needs the running total.
    const inside = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id
          if (entry.isIntersecting) inside.add(id)
          else inside.delete(id)
        }
        const first = targets.find((target) => inside.has(target.id))
        if (first !== undefined) setActive(first.id)
      },
      { rootMargin: '-100px 0px -65% 0px', threshold: 0 },
    )
    for (const target of targets) observer.observe(target)
    setActive(targets[0]?.id ?? null)
    return () => observer.disconnect()
  }, [html])

  if (headings.length < 2) return <div className="doc-contents" />

  return (
    <nav aria-label="On this page" className="doc-contents">
      <div className="doc-contents-inner">
        <p className="type-label mb-2 text-slate-400">On This Page</p>
        <ul className="flex flex-col">
          {headings.map((heading) => (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                aria-current={heading.id === active ? 'true' : undefined}
                className={`type-ui block truncate border-l py-[3px] transition-colors ${
                  heading.depth >= 3 ? 'pl-5' : 'pl-3'
                } ${
                  heading.id === active
                    ? 'border-sky-400 text-sky-200'
                    : 'border-slate-800 text-slate-400 hover:border-slate-600 hover:text-sky-200'
                }`}
                title={heading.text}
              >
                {heading.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  )
}
