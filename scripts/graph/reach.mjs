/*
 * What a module's static imports reach, binding by binding.
 *
 * The layering in `check-graph.mjs` reads manifests, so it sees that
 * `apps/game` depends on `@inertialref/rendering` and nothing finer. A page
 * pays for modules, not packages: one constant read from the cloud march put
 * the march, the weather field and the mie table (190 kB gzipped) in `App`'s
 * chunk graph, and every page without `?clouds=1` loaded them. The build does
 * not fail on that and the gate does not build, so this walks the sources.
 *
 * The walk keeps what Rollup keeps, which differs by package. A package that
 * declares `"sideEffects": false` (every one under `packages/`) is followed
 * binding by binding: `App` reads a constant of `weatherField.ts` through the
 * `@inertialref/rendering` barrel, that file imports the mie table for
 * another binding, and the bundler keeps the constant and drops the table. So
 * asking such a module for a name makes live the top-level declaration that
 * holds it, every top-level declaration that one names, and every import
 * those name, and a re-export is followed only for the names asked of it.
 * Once it is reached, its top-level statements that declare nothing are
 * live, and so is each declaration whose initializer calls or constructs,
 * since the bundler keeps a call it cannot prove pure. `apps/game` declares
 * no such thing, so a module of it that is reached is taken whole, every
 * import with it: one constant of the march took every module the march
 * imports into every page. It over-approximates where a name is shadowed or
 * is a property key. It does not model the bundler's chunking, which counts a
 * binding live if any entry reads it: that is the path by which the march's
 * modules took the mie table along, and the walk refuses the march instead.
 * Type-only imports and `import()` are not edges: the first is erased, and
 * the second is the lazy boundary the clouds load behind.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import ts from 'typescript'

const ALL = Symbol('every binding')

/**
 * The static reach of `entry` (a path relative to `root`): the files with a
 * live binding or a live statement, and for every file visited the file that
 * first asked it for something, so a refusal can print the path to it.
 */
export function staticReach(root, entry) {
  const parsed = new Map()
  const parse = (file) => {
    let module = parsed.get(file)
    if (module === undefined) {
      module = readModule(root, file)
      parsed.set(file, module)
    }
    return module
  }
  const provides = (file, name, seen = new Set()) => {
    if (seen.has(file)) return false
    seen.add(file)
    const module = parse(file)
    if (module.exports.has(name)) return true
    if (module.reexports.some((r) => r.names.has(name))) return true
    return module.stars.some((star) => provides(star, name, seen))
  }

  const via = new Map([[entry, null]])
  const entered = new Set()
  const live = new Map()
  const asked = new Map()
  const queue = []
  const ask = (file, names, from) => {
    if (!via.has(file)) via.set(file, from)
    queue.push({ file, names })
  }
  const mark = (file, ident) => {
    const marked = live.get(file)
    if (marked.has(ident)) return
    marked.add(ident)
    const module = parse(file)
    const binding = module.imports.get(ident)
    if (binding !== undefined)
      ask(
        binding.file,
        binding.name === ALL ? ALL : new Set([binding.name]),
        file,
      )
    const refs = module.locals.get(ident)
    if (refs === undefined) return
    entered.add(file)
    for (const ref of refs) mark(file, ref)
  }
  const pure = new Map()
  const treeShaken = (file) => {
    for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) {
      if (pure.has(dir)) return pure.get(dir)
      const manifest = join(root, dir, 'package.json')
      if (!existsSync(manifest)) continue
      const declared = JSON.parse(readFileSync(manifest, 'utf8')).sideEffects
      pure.set(dir, declared === false)
      return declared === false
    }
    return false
  }
  const reach = (file) => {
    if (live.has(file)) return
    live.set(file, new Set())
    const module = parse(file)
    for (const target of module.bare) ask(target, new Set(), file)
    if (module.effects.size > 0) entered.add(file)
    for (const ident of module.effects) mark(file, ident)
    if (treeShaken(file)) return
    entered.add(file)
    for (const ident of [...module.locals.keys(), ...module.imports.keys()])
      mark(file, ident)
  }

  reach(entry)
  while (queue.length > 0) {
    const { file, names } = queue.shift()
    const module = parse(file)
    reach(file)
    const before = asked.get(file) ?? new Set()
    asked.set(file, before)
    if (names === ALL) {
      if (before.has(ALL)) continue
      before.add(ALL)
      for (const star of module.stars) ask(star, ALL, file)
    }
    const wanted =
      names === ALL
        ? [...module.exports.keys(), ...module.reexportedNames()]
        : names
    for (const name of wanted) {
      if (before.has(name)) continue
      before.add(name)
      const local = module.exports.get(name)
      if (local !== undefined) {
        mark(file, local)
        continue
      }
      const named = module.reexports.find((r) => r.names.has(name))
      if (named !== undefined) {
        const inner = named.names.get(name)
        ask(named.file, inner === ALL ? ALL : new Set([inner]), file)
        continue
      }
      for (const star of module.stars)
        if (provides(star, name)) ask(star, new Set([name]), file)
    }
  }
  return { entered, via }
}

/** The chain of files by which `staticReach` reached `file`. */
export function pathTo({ via }, file) {
  const chain = []
  for (let at = file; at !== null && at !== undefined; at = via.get(at))
    chain.unshift(at)
  return chain
}

function readModule(root, file) {
  const text = readFileSync(join(root, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
  /** Local name → the module and name it is imported as. */
  const imports = new Map()
  /** Top-level declared name → the identifiers its declaration names. */
  const locals = new Map()
  /** Exported name → local name. */
  const exports = new Map()
  /** Identifiers named by top-level statements that declare nothing. */
  const effects = new Set()
  const bare = []
  const reexports = []
  const stars = []
  const has = (node, kind) => node.modifiers?.some((m) => m.kind === kind)
  const declare = (name, node, exported) => {
    locals.set(name, identifiers(node))
    if (exported) exports.set(name, name)
  }
  /** Top-level names whose initializer calls or constructs. */
  const calls = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const target = resolve(root, file, statement.moduleSpecifier.text)
      const clause = statement.importClause
      if (target === null || clause?.isTypeOnly) continue
      if (clause === undefined) {
        bare.push(target)
        continue
      }
      if (clause.name !== undefined)
        imports.set(clause.name.text, { file: target, name: 'default' })
      const bindings = clause.namedBindings
      if (bindings !== undefined && ts.isNamespaceImport(bindings))
        imports.set(bindings.name.text, { file: target, name: ALL })
      else
        for (const element of bindings?.elements ?? [])
          if (!element.isTypeOnly)
            imports.set(element.name.text, {
              file: target,
              name: (element.propertyName ?? element.name).text,
            })
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue
      const clause = statement.exportClause
      if (statement.moduleSpecifier === undefined) {
        for (const element of clause?.elements ?? [])
          if (!element.isTypeOnly)
            exports.set(
              element.name.text,
              (element.propertyName ?? element.name).text,
            )
        continue
      }
      const target = resolve(root, file, statement.moduleSpecifier.text)
      if (target === null) continue
      if (clause === undefined) stars.push(target)
      else if (ts.isNamespaceExport(clause))
        reexports.push({
          file: target,
          names: new Map([[clause.name.text, ALL]]),
        })
      else {
        const names = new Map()
        for (const element of clause.elements)
          if (!element.isTypeOnly)
            names.set(
              element.name.text,
              (element.propertyName ?? element.name).text,
            )
        reexports.push({ file: target, names })
      }
    } else if (ts.isExportAssignment(statement)) {
      declare('default', statement.expression, true)
    } else if (ts.isVariableStatement(statement)) {
      const exported = has(statement, ts.SyntaxKind.ExportKeyword)
      for (const declaration of statement.declarationList.declarations) {
        const names = new Set()
        collectNames(declaration.name, names)
        for (const name of names) declare(name, declaration, exported)
        if (declaration.initializer && invokes(declaration.initializer))
          calls.push(...names)
      }
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      const exported = has(statement, ts.SyntaxKind.ExportKeyword)
      const isDefault = has(statement, ts.SyntaxKind.DefaultKeyword)
      const name = statement.name?.text ?? 'default'
      declare(name, statement, exported && !isDefault)
      if (isDefault) exports.set('default', name)
    } else if (
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isModuleDeclaration(statement) &&
      !ts.isEmptyStatement(statement)
    ) {
      for (const ident of identifiers(statement)) effects.add(ident)
    }
  }
  for (const name of calls) effects.add(name)
  return {
    imports,
    locals,
    exports,
    effects,
    bare,
    reexports,
    stars,
    reexportedNames: () => reexports.flatMap((r) => [...r.names.keys()]),
  }
}

/**
 * Whether evaluating `node` at module scope may call: a call, a `new` or a
 * tagged template outside any function body it holds.
 */
function invokes(node) {
  if (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isTaggedTemplateExpression(node)
  )
    return true
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false
  return ts.forEachChild(node, (child) => invokes(child) || undefined) === true
}

function identifiers(node) {
  const found = new Set()
  const visit = (child) => {
    if (ts.isIdentifier(child)) found.add(child.text)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function collectNames(name, into) {
  if (ts.isIdentifier(name)) into.add(name.text)
  else
    for (const element of name.elements)
      if (!ts.isOmittedExpression(element)) collectNames(element.name, into)
}

/**
 * A specifier's file relative to `root`, or null for a third-party package,
 * an asset or a Vite query: none of those carries a workspace module.
 */
function resolve(root, from, specifier) {
  if (specifier.includes('?')) return null
  let path
  if (specifier.startsWith('.')) path = join(dirname(from), specifier)
  else if (specifier.startsWith('@/'))
    path = join('apps/game/src', specifier.slice(2))
  else if (specifier.startsWith('@inertialref/')) {
    const [, name, ...rest] = specifier.split('/')
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'),
    )
    const key = rest.length === 0 ? '.' : `./${rest.join('/')}`
    const target = manifest.exports?.[key]
    const entry = typeof target === 'string' ? target : target?.import
    if (typeof entry !== 'string')
      throw new Error(`${from}: ${specifier} names no export of ${name}`)
    path = join('packages', name, entry)
  } else return null
  for (const candidate of [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}/index.ts`,
  ])
    if (
      /\.(ts|tsx|mts|mjs)$/.test(candidate) &&
      existsSync(join(root, candidate))
    )
      return relative(root, join(root, candidate))
  return null
}
