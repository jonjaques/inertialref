/*
 * The eighty-three diagrams, drawn on demand.
 *
 * **Why this is not a build step.** Mermaid lays a graph out by measuring the
 * text in it, which needs a real DOM with real fonts — so drawing these at
 * build time means a headless browser in the toolchain, for a corpus where
 * twenty documents have a diagram and fifty do not. The library is imported
 * dynamically instead, so it is a chunk that only a reader who opens one of
 * those twenty pages ever fetches, and the service worker keeps it after the
 * first.
 *
 * **What happens when it does not arrive.** The source is what is on screen.
 * `scripts/docs/markdown.mjs` emits every diagram as its own text inside a
 * `<pre>`, styled like any other listing, and this replaces it once a picture
 * exists. Offline on a cold cache, or behind a blocked import, the page still
 * carries a diagram somebody can read — which is more than a broken image
 * placeholder, and is the reason the source is the initial state rather than a
 * fallback that has to be swapped in.
 */

/** Set once, on the module's own instance, before the first render. */
let configured = false

/**
 * A per-call counter for the ids Mermaid needs.
 *
 * It writes `id`s into the SVG it returns — for markers, clip paths and the
 * arrowheads that reference them — so two diagrams sharing one prefix on the
 * same page produce two elements with the same id, and every arrowhead in the
 * second diagram resolves against the first's marker. Which reads as arrows
 * that have quietly lost their heads.
 */
let sequence = 0

/**
 * Replace every diagram source inside a container with the drawing of it.
 *
 * Sequential rather than `Promise.all`, deliberately: Mermaid renders through a
 * single hidden element and its own internal state, and concurrent calls
 * interleave into each other's layout. Nine diagrams on `concepts/rendering`
 * take about a fifth of a second in a row, which is after the text is already
 * readable.
 */
export async function drawDiagrams(container: HTMLElement): Promise<void> {
  const blocks = [...container.querySelectorAll<HTMLElement>('pre.doc-mermaid')]
  if (blocks.length === 0) return

  const mermaid = (await import('mermaid')).default
  if (!configured) {
    mermaid.initialize(CONFIG)
    configured = true
  }

  for (const block of blocks) {
    // A container React has already replaced under us: its nodes are detached
    // and drawing into them is work nobody will see.
    if (!block.isConnected) return
    const source = block.textContent ?? ''
    try {
      const { svg } = await mermaid.render(
        `ir-diagram-${(sequence += 1)}`,
        source,
      )
      if (!block.isConnected) return
      const drawn = document.createElement('div')
      drawn.className = 'doc-diagram-svg'
      drawn.innerHTML = svg
      block.replaceWith(drawn)
    } catch {
      // A diagram Mermaid cannot parse is a bug in the document, and the
      // document is what is left on screen — which is both the honest thing to
      // show and the thing that says where the bug is.
      block.classList.add('doc-mermaid-failed')
    }
  }
}

/*
 * The palette, restated for a library that cannot read a stylesheet.
 *
 * Mermaid computes its own derived colours — a node's border from its fill, a
 * label's ink from its background — so it takes hex values rather than the
 * custom properties everything else in this interface uses. Each line names the
 * step in `DESIGN.md` it is, because a bare hex three files from the palette is
 * a colour nobody can check.
 *
 * The whole diagram is drawn in the graphite ramp with the accent on the edges,
 * which is the One Accent Rule applied to a picture: a flowchart is structure,
 * and structure in this system is a hairline and a label rather than a fill.
 */
const CONFIG = {
  startOnLoad: false,
  /* Ours is the only markup that reaches this, and it is generated from files
     in the repository — but it is still markup being turned into a DOM, and
     `strict` is what keeps a document unable to script the page it is on. It
     permits the `<b>` and `<br/>` these diagrams use in their labels. */
  securityLevel: 'strict' as const,
  theme: 'base' as const,
  fontFamily: "'IBM Plex Sans Variable', ui-sans-serif, system-ui, sans-serif",
  themeVariables: {
    darkMode: true,
    background: 'transparent',
    fontFamily:
      "'IBM Plex Sans Variable', ui-sans-serif, system-ui, sans-serif",
    fontSize: '13px',

    primaryColor: '#0f172a' /* slate-900 — a node's ground */,
    primaryTextColor: '#e2e8f0' /* slate-200 — the brightest neutral */,
    primaryBorderColor: '#475569' /* slate-600, as a line rather than as ink */,
    secondaryColor: '#1e293b' /* slate-800 */,
    secondaryTextColor: '#cbd5e1' /* slate-300 */,
    secondaryBorderColor: '#334155' /* slate-700 */,
    tertiaryColor: '#020617' /* slate-950 */,
    tertiaryTextColor: '#cbd5e1',
    tertiaryBorderColor: '#334155',

    lineColor:
      '#64748b' /* slate-500 — an edge is not text, and 3:1 is its bar */,
    textColor: '#cbd5e1',
    mainBkg: '#0f172a',
    nodeBorder: '#475569',
    nodeTextColor: '#e2e8f0',
    clusterBkg: 'rgba(15, 23, 42, 0.5)' /* slate-900/50 */,
    clusterBorder: '#334155',
    titleColor: '#7dd3fc' /* sky-300 — a subgraph's name is the one accent */,
    edgeLabelBackground: '#020617',
    labelBoxBkgColor: '#0f172a',
    labelBoxBorderColor: '#334155',
    labelTextColor: '#e2e8f0',

    /* Sequence and state diagrams reach for their own names for the same
       surfaces. Pointed at the same three values so a page that mixes diagram
       types does not mix palettes. */
    actorBkg: '#0f172a',
    actorBorder: '#475569',
    actorTextColor: '#e2e8f0',
    signalColor: '#94a3b8' /* slate-400 */,
    signalTextColor: '#cbd5e1',
    noteBkgColor: '#1e293b',
    noteTextColor: '#e2e8f0',
    noteBorderColor: '#334155',
  },
  flowchart: {
    /* Curves, because every one of these diagrams is a dependency or a data
       path rather than a circuit, and an orthogonal router puts right angles
       where the reader reads a junction. */
    curve: 'basis' as const,
    padding: 12,
    /*
     * Natural size, and the container scrolls.
     *
     * `useMaxWidth: true` makes the SVG fluid, which is right until the
     * container is a phone: a seven-node flowchart drawn into 430 px is a
     * diagram whose labels are four pixels tall — technically responsive and
     * completely unreadable. Drawn at its own size it stays legible and the
     * figure scrolls sideways, which is what `.doc-table` already does with a
     * nine-column table for the same reason. `index.css` puts the ceiling back
     * above 640 px, where the column is wide enough for one to fit.
     */
    useMaxWidth: false,
  },
  sequence: { useMaxWidth: false },
}
