#!/usr/bin/env node
/*
 * A page without `?clouds=1` loads none of the cloud system.
 *
 * `App` reaches the clouds through `import()` alone. A static edge from its
 * graph into the march takes the march's modules into every page, and through
 * them the mie table (190 kB gzipped), and nothing else fails on it: the build
 * succeeds, and the layering in `check-graph.mjs` reads manifests, which say
 * only that `apps/game` depends on `@inertialref/rendering`.
 *
 * So this asks the bundler. It builds `App.tsx` with the app's own Vite
 * config (`gameVite`, the one Astro builds with), writes nothing, and takes
 * the static closure of the entry chunk: what the page loads before any
 * `import()`. A walk over the sources cannot stand in for that. Vite resolves
 * a directory to `index.tsx`, keeps `import { type X }` as a side-effect
 * import under `verbatimModuleSyntax`, follows a re-export when the barrel
 * holding it is imported for its effects, erases a type annotation's
 * reference, and tree-shakes `packages/*` by binding (`"sideEffects": false`)
 * but `apps/game` by module; a resolver written beside it drifts on each.
 *
 * Two of `gameVite`'s plugins are left out, because they cost eight of the
 * build's nine seconds and add no edge between workspace modules: the React
 * Compiler's Babel pass, which imports only `react/compiler-runtime`, and
 * Tailwind, which writes CSS. The repository's own plugins, the alias, the
 * `define`s and the worker format stay. About a second on this Mac mini.
 */
import { relative } from 'node:path'
import { build, mergeConfig } from 'vite'

const root = new URL('..', import.meta.url).pathname
const app = `${root}apps/game/`
const ENTRY = 'apps/game/src/App.tsx'

/**
 * Modules no page loads before `?clouds=1` asks for them. `weatherField`
 * gives `App` one constant, `UNSPREAD_SHAPE`, which the bundler inlines; the
 * field itself stays behind the `import()`.
 */
const REFUSED = [
  'apps/game/src/render/cloudSystem.ts',
  'apps/game/src/render/cloudTrace.ts',
  'apps/game/src/render/cloudMarch.ts',
  'packages/rendering/src/weatherField.ts',
  'packages/rendering/src/mieTable.ts',
  'packages/rendering/src/mieDroplets.generated.ts',
]

const KEPT_PLUGIN = /^inertialref:/

const { gameVite } = await import(`${app}vite.config.ts`)
const config = gameVite('production')
// The Babel plugin has no name to match until it resolves, so the filter
// keeps the repository's own by name rather than dropping the others by it.
config.plugins = config.plugins
  .flat(Infinity)
  .filter((plugin) => KEPT_PLUGIN.test(String(plugin?.name ?? '')))

// The static importer chain to a refused module, for the message. Taken from
// the module graph, which still holds edges tree-shaking later drops, so it
// names a path the bundler could take, and the closure decides.
const chains = new Map()
const witness = {
  name: 'check-chunks:witness',
  generateBundle() {
    const entry = `${root}${ENTRY}`
    const from = new Map([[entry, null]])
    const queue = [entry]
    while (queue.length > 0) {
      const id = queue.shift()
      for (const next of this.getModuleInfo(id)?.importedIds ?? []) {
        if (from.has(next)) continue
        from.set(next, id)
        queue.push(next)
      }
    }
    for (const file of REFUSED) {
      const chain = []
      for (let at = `${root}${file}`; from.has(at); at = from.get(at)) {
        chain.unshift(relative(root, at))
        if (from.get(at) === null) break
      }
      chains.set(file, chain)
    }
  },
}

const result = await build(
  mergeConfig(config, {
    root: app,
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    plugins: [witness],
    build: {
      write: false,
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      rollupOptions: { input: { App: `${root}${ENTRY}` } },
    },
  }),
)

const chunks = new Map(
  (Array.isArray(result) ? result : [result])
    .flatMap((output) => output.output)
    .filter((item) => item.type === 'chunk')
    .map((chunk) => [chunk.fileName, chunk]),
)
const entries = [...chunks.values()].filter((chunk) => chunk.isEntry)
if (entries.length !== 1)
  throw new Error(`expected one entry chunk, found ${entries.length}`)
const closure = new Set()
const queue = [entries[0].fileName]
while (queue.length > 0) {
  const name = queue.pop()
  if (closure.has(name)) continue
  closure.add(name)
  queue.push(...chunks.get(name).imports)
}
const loaded = new Set(
  [...closure]
    .flatMap((name) => chunks.get(name).moduleIds)
    .map((id) => relative(root, id)),
)

const problems = REFUSED.filter((file) => loaded.has(file)).map(
  (file) =>
    `${ENTRY} loads ${file} before any import(), so every page does` +
    (chains.get(file)?.length ? ` (${chains.get(file).join(' → ')})` : ''),
)
if (problems.length > 0) {
  console.error('A page without ?clouds=1 loads the cloud system:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(
  `${ENTRY} loads ${loaded.size} modules in ${closure.size} chunks before any import(), ` +
    `none of the ${REFUSED.length} the clouds load behind it`,
)
