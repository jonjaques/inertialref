/*
 * Where British spelling survives in the tree, and what it would cost to remove
 * each one. `pnpm spelling`.
 *
 * `STYLE.md` § "American English" makes the rule and then suspends half of
 * it: prose follows American English, code follows the identifier that exists,
 * "until a dedicated rename". This is the instrument that rename needs, because
 * the operation is not a search and replace and the difference matters twice.
 *
 * A regex over the tree is wrong in both directions. It matches text that is
 * not a word — `CapabilityResult` contains `tyRe` — and, worse, it cannot see
 * the boundary that makes a rename unsafe: an identifier that also exists as a
 * key in checked-in data. Renaming the TypeScript property `licence` to
 * `license` compiles clean and then reads `undefined` out of
 * `data/textures/manifest.json`, which still says `licence`.
 *
 * So this reads declarations through the TypeScript compiler — ts-morph gives
 * the same symbol graph `tsc` uses — and grades each one:
 *
 *   local     the declaration and every reference are inside one file
 *   internal  referenced across files, but the symbol never leaves the source
 *   boundary  the name also occurs as a quoted string or a data key, so the
 *             rename has a second half that the compiler cannot perform
 *
 * Only the third grade needs a human. The first two are what `rename()` is for:
 * it moves the declaration and every reference the checker can see, including
 * import specifiers, shorthand properties and indexed-access types like
 * `TravelTarget['colour']`, which is exactly the set a regex gets wrong.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Node, Project, SyntaxKind } from 'ts-morph'
import { americanize, rulesFiring } from './dictionary.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/*
 * One Project over the whole tree rather than one per tsconfig. The five
 * tsconfigs disagree about `lib` and `types` on purpose — `packages/*` has no
 * DOM — and loading them separately would put a package's declaration in one
 * program and `apps/game`'s reference to it in another, which is precisely the
 * cross-workspace reference this has to follow. Type errors do not matter here;
 * symbol resolution does, and that only needs the paths.
 */
const project = new Project({
  compilerOptions: {
    target: 99,
    module: 199,
    moduleResolution: 100, // bundler
    jsx: 4, // react-jsx
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: ROOT,
    paths: { '@/*': ['apps/game/src/*'] },
  },
  skipAddingFilesFromTsConfig: true,
})
project.addSourceFilesAtPaths([
  `${ROOT}apps/*/src/**/*.{ts,tsx}`,
  `${ROOT}packages/*/src/**/*.ts`,
  `${ROOT}apps/*/*.config.ts`,
  `${ROOT}*.ts`,
  `!${ROOT}**/node_modules/**`,
])

/**
 * The name node of a declaration, when `node` is one. Import and export
 * specifiers are excluded: renaming a symbol rewrites those automatically, and
 * treating them as declarations double-counts every re-export.
 */
const DECLARATIONS = new Set([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.EnumMember,
  SyntaxKind.PropertySignature,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Parameter,
  SyntaxKind.BindingElement,
  SyntaxKind.TypeParameter,
])

const found = []
for (const file of project.getSourceFiles()) {
  const path = file.getFilePath().replace(ROOT, '')
  if (path.includes('node_modules')) continue
  file.forEachDescendant((node) => {
    if (!Node.isIdentifier(node)) return
    const parent = node.getParent()
    if (parent === undefined || !DECLARATIONS.has(parent.getKind())) return
    if (parent.getNameNode?.() !== node) return
    const name = node.getText()
    const renamed = americanize(name)
    if (renamed === name) return
    found.push({
      path,
      line: node.getStartLineNumber(),
      kind: parent.getKindName(),
      name,
      renamed,
      rules: rulesFiring(name),
      exported: Boolean(
        parent.getFirstAncestor?.(
          (a) => Node.isExportable(a) && a.isExported?.(),
        ),
      ),
      refs: countRefs(node),
    })
  })
}

/** How many places the checker would have to rewrite, and in how many files. */
function countRefs(node) {
  try {
    const files = new Set()
    let n = 0
    for (const symbol of node.findReferences())
      for (const ref of symbol.getReferences()) {
        n += 1
        files.add(ref.getSourceFile().getFilePath())
      }
    return { count: n, files: files.size }
  } catch {
    return { count: 0, files: 0 }
  }
}

/*
 * The boundary test. One ripgrep for every distinct name at once, over the
 * files a compiler never opens — checked-in data, stylesheets, shaders, the
 * service worker — plus quoted occurrences inside TypeScript. A hit means the
 * name has a second life as text, and renaming the declaration alone would
 * split the two.
 */
const names = [...new Set(found.map((f) => f.name))]

function rg(args) {
  try {
    return execFileSync('rg', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return '' // rg exits 1 when nothing matches, which is the common case here
  }
}

/** Every place a British name also occurs as a quoted string, keyed by name. */
const quoted = new Map()
for (const name of names) {
  const where = rg([
    '--no-heading',
    '-n',
    '--color=never',
    // Glob order is load-bearing: ripgrep gives a later glob precedence over an
    // earlier one, so the include has to come first or it re-admits everything
    // the negations below just removed.
    '-g',
    '*.{json,css,html,wgsl,glsl,js,svg,ts,tsx,mjs}',
    '-g',
    '!**/node_modules/**',
    '-g',
    '!**/coverage/**',
    '-g',
    '!**/dist/**',
    // The tool must not measure itself: `dictionary.mjs` quotes every British
    // spelling it knows by construction, and without this it reports all of
    // them as boundary cases found in its own source.
    '-g',
    '!**/scripts/spelling/**',
    // `worker-configuration.d.ts` is `wrangler types` output describing
    // Cloudflare's API, where `"cancelled"` is their spelling of their field.
    '-g',
    '!**/worker-configuration.d.ts',
    '-e',
    `"${name}"`,
    '-e',
    `'${name}'`,
    ROOT,
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(ROOT.length).split(':').slice(0, 2).join(':'))
  if (where.length > 0) quoted.set(name, where)
}

for (const f of found)
  f.grade = quoted.has(f.name)
    ? 'boundary'
    : f.refs.files > 1
      ? 'internal'
      : 'local'

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(found, null, 2))
} else {
  const by = (k) => found.filter((f) => f.grade === k)
  console.log(
    `${found.length} identifier declarations spelled British, in ${new Set(found.map((f) => f.path)).size} files\n`,
  )
  console.log('  grade     decls  references')
  for (const g of ['local', 'internal', 'boundary'])
    console.log(
      `  ${g.padEnd(9)} ${String(by(g).length).padStart(5)}  ${String(by(g).reduce((n, f) => n + f.refs.count, 0)).padStart(10)}`,
    )
  const byRule = new Map()
  for (const f of found)
    for (const r of f.rules) byRule.set(r, (byRule.get(r) ?? 0) + 1)
  console.log('\n  spelling      decls')
  for (const [r, n] of [...byRule].sort((a, b) => b[1] - a[1]))
    console.log(`  ${r.padEnd(13)} ${String(n).padStart(5)}`)
  console.log(
    '\n  boundary names — the rename has a second half the compiler cannot do:',
  )
  for (const [name, where] of [...quoted].sort()) {
    const decls = found.filter((f) => f.name === name)
    console.log(
      `\n    ${name} → ${americanize(name)}  (${decls.length} declaration${decls.length === 1 ? '' : 's'})`,
    )
    for (const w of where.slice(0, 6)) console.log(`      also text at ${w}`)
    if (where.length > 6) console.log(`      … and ${where.length - 6} more`)
  }
}
