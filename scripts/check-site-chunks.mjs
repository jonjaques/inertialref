#!/usr/bin/env node
/*
 * No page of the built site loads the cloud system before `?clouds=1` asks
 * for it, and the game's page loads the number of chunks it is meant to.
 *
 * This reads what Astro wrote, because nothing short of the site holds it.
 * `check-chunks.mjs` builds `App` alone in the gate; Astro builds every
 * entry together and shares a chunk between entries that both read it, so a
 * table imported by `Root`, which all 162 shell pages load, or a module two
 * entries share, reaches pages an `App` build never shows.
 *
 * A page loads the `/assets/*.js` its HTML names (Astro's island component
 * and renderer, the scripts and preloads) and every chunk those import
 * statically. Where that reaches `runtimeLoader.ts`, it also loads what the
 * loader imports on every boot, through `import()` but unconditionally
 * (`STARTUP`), and the universe worker the engine starts. A chunk's modules
 * are the sources its map lists. The build writes a map for every script
 * that holds repository code (`requireSourceMaps` in the Vite config); the
 * ones it does not are Vite's own preload helper and the facades that only
 * re-export another chunk, which this reads as holding no module and counts.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { CLOUD_MODULES, root, sourcePath } from './cloudModules.mjs'

const dist = join(root, 'apps/game/dist')

/**
 * The static chunk closure of the game's page, `index.html`, with its
 * startup and its worker. A change to it is a decision about what every
 * visit downloads, so it is stated here rather than read off the build:
 * update it with the reason in the commit, and look at what moved. It is
 * the 56 chunks reached from `client`, `Root`, `App` and the worker, and the
 * two more that `clientStartup` and `catalogAsset` bring, which the loader
 * imports on every boot.
 */
const GAME_PAGE_CHUNKS = 58

/** What `runtimeLoader.ts` imports on every boot, through `import()`. */
const LOADER = 'apps/game/src/runtimeLoader.ts'
const STARTUP = [
  'apps/game/src/App.tsx',
  'apps/game/src/clientStartup.ts',
  'apps/game/src/engine/catalogAsset.ts',
]

const STATIC_IMPORT =
  /(?:^|[;\s}])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["'`]([^"'`]+\.js)["'`]/g
const WORKER = [
  /new\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*["'`]([^"'`]+\.js)["'`]/g,
  /["'`]((?:\.\/|\/assets\/)?universe\.worker-[\w-]+\.js)["'`]/g,
]
const PAGE_SCRIPT = /\/assets\/[\w.-]+\.js/g

const chunks = new Map()
let unmapped = 0
for (const file of readdirSync(dist, { recursive: true })) {
  if (!file.endsWith('.js') || !file.startsWith('assets/')) continue
  const text = readFileSync(join(dist, file), 'utf8')
  const map = join(dist, `${file}.map`)
  if (!existsSync(map)) unmapped += 1
  const at = (specifier) =>
    relative(
      dist,
      specifier.startsWith('/')
        ? join(dist, specifier)
        : join(dist, dirname(file), specifier),
    )
  chunks.set(file, {
    imports: [...text.matchAll(STATIC_IMPORT)].map((m) => at(m[1])),
    workers: WORKER.flatMap((pattern) =>
      [...text.matchAll(pattern)].map((m) => at(m[1])),
    ),
    modules: existsSync(map)
      ? JSON.parse(readFileSync(map, 'utf8')).sources.map((source) =>
          sourcePath(source, join(dist, dirname(file))),
        )
      : [],
  })
}
const holding = (module) =>
  [...chunks].filter(([, c]) => c.modules.includes(module)).map(([f]) => f)

/** The chunks a page whose HTML names `roots` loads, each with the chunk that first imported it. */
function loads(roots) {
  const by = new Map(roots.map((file) => [file, null]))
  const queue = [...roots]
  const add = (file, from) => {
    if (by.has(file) || !chunks.has(file)) return
    by.set(file, from)
    queue.push(file)
  }
  let started = false
  while (queue.length > 0) {
    const file = queue.shift()
    const chunk = chunks.get(file)
    if (chunk === undefined) continue
    for (const next of chunk.imports) add(next, file)
    for (const next of chunk.workers) add(next, file)
    if (!started && chunk.modules.includes(LOADER)) {
      started = true
      for (const module of STARTUP)
        for (const next of holding(module)) add(next, `${file} (startup)`)
    }
  }
  return by
}

const problems = []
let pages = 0
let gamePage = null
for (const file of readdirSync(dist, { recursive: true })) {
  if (!file.endsWith('.html')) continue
  pages += 1
  const html = readFileSync(join(dist, file), 'utf8')
  const roots = [...new Set(html.match(PAGE_SCRIPT) ?? [])].map((s) =>
    s.slice(1),
  )
  const loaded = loads(roots)
  if (file === 'index.html') gamePage = loaded
  for (const [chunk] of loaded) {
    for (const module of chunks.get(chunk)?.modules ?? []) {
      if (!CLOUD_MODULES.includes(module)) continue
      const chain = []
      for (let at = chunk; at !== null; at = loaded.get(at.split(' ')[0]))
        chain.unshift(at)
      problems.push(`${file} loads ${module} in ${chain.join(' → ')}`)
    }
  }
}

assert(gamePage !== null, 'the build wrote no index.html')
if (gamePage.size !== GAME_PAGE_CHUNKS)
  problems.push(
    `index.html loads ${gamePage.size} chunks, where GAME_PAGE_CHUNKS says ${GAME_PAGE_CHUNKS}`,
  )
if (problems.length > 0) {
  // One line per module is enough to act on; a table on every page repeats
  // itself a hundred and sixty times.
  const shown = [...new Set(problems)]
  console.error(
    `site chunks: ${shown.length} problems, in ${pages} pages (first 12):`,
  )
  for (const problem of shown.slice(0, 12)) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(
  `site chunks: ${pages} pages load none of the ${CLOUD_MODULES.length} cloud modules before ?clouds=1, ` +
    `and index.html loads ${gamePage.size} chunks (${chunks.size} scripts, ${unmapped} without a map)`,
)
