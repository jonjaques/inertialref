/**
 * The minimum for private bytes per shader and function bytes per function.
 * https://www.w3.org/TR/WGSL/#limits
 */
export const WGSL_STORAGE_LIMIT = 8192

interface Layout {
  readonly size: number
  readonly align: number
}

const scalar: Readonly<Record<string, Layout>> = {
  bool: { size: 4, align: 4 },
  f16: { size: 2, align: 2 },
  f32: { size: 4, align: 4 },
  i32: { size: 4, align: 4 },
  u32: { size: 4, align: 4 },
}

const roundUp = (size: number, align: number): number =>
  Math.ceil(size / align) * align

// Struct members, parameters and constructors can contain nested commas.
function commaList(list: string): string[] {
  let nesting = 0
  let start = 0
  const parts: string[] = []
  for (let i = 0; i < list.length; i++) {
    const char = list[i]
    if (char === '<' || char === '(') nesting++
    if (char === '>' || char === ')') nesting--
    if (char === ',' && nesting === 0) {
      parts.push(list.slice(start, i).trim())
      start = i + 1
    }
  }
  if (list.slice(start).trim() !== '') parts.push(list.slice(start).trim())
  return parts
}

function removeComments(source: string): string {
  let depth = 0
  let start = 0
  let code = ''
  const comments = /\/\/|\/\*|\*\//g
  let match: RegExpExecArray | null
  while ((match = comments.exec(source)) !== null) {
    const token = match[0]
    const at = match.index
    if (token === '//') {
      if (depth !== 0) continue
      code += source.slice(start, at) + ' '
      const newline = source.indexOf('\n', at)
      start = newline === -1 ? source.length : newline
      comments.lastIndex = start
    } else if (token === '/*') {
      if (depth === 0) code += source.slice(start, at) + ' '
      depth++
    } else {
      depth--
      if (depth === 0) start = at + token.length
    }
  }
  return code + source.slice(start)
}

function closingDelimiter(code: string, start: number, end: string): number {
  let depth = 1
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === code[start]) depth++
    if (code[i] === end && --depth === 0) return i
  }
  throw new Error('Unclosed WGSL declaration')
}

/** SizeOf and AlignOf for fixed-footprint storage. https://www.w3.org/TR/WGSL/#alignment-and-size */
function layouts(code: string): (type: string) => Layout {
  const structs = new Map(
    Array.from(
      code.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g),
      ([, name, members]) => [name!, commaList(members!)],
    ),
  )
  const aliases = new Map(
    Array.from(
      code.matchAll(/\balias\s+(\w+)\s*=\s*([^;]+);/g),
      ([, name, type]) => [name!, type!],
    ),
  )
  const found = new Map(Object.entries(scalar))
  function layoutOf(written: string): Layout {
    const type = written.replace(/\s/g, '')
    const cached = found.get(type)
    if (cached !== undefined) return cached

    const alias = aliases.get(type)
    const members = structs.get(type)
    const shape =
      /^(vec([234])|mat([234])x([234]))(?:<([\w]+)>|([fhiub]))$/.exec(type)
    const array = /^array<(.+),([^,<>]+)>$/.exec(type)
    let result: Layout
    if (alias !== undefined) {
      result = layoutOf(alias)
    } else if (members !== undefined) {
      let size = 0
      let align = 1
      for (const member of members) {
        const field = /^\s*((?:@\w+\s*\([^)]*\)\s*)*)\w+\s*:\s*(.+)$/.exec(
          member,
        )
        if (field === null) throw new Error(`Unknown WGSL field ${member}`)
        const { size: naturalSize, align: naturalAlign } = layoutOf(field[2]!)
        const offsetAlign = Number(
          /@align\(\s*(\d+)\s*\)/.exec(field[1]!)?.[1] ?? naturalAlign,
        )
        const fieldSize = Number(
          /@size\(\s*(\d+)\s*\)/.exec(field[1]!)?.[1] ?? naturalSize,
        )
        size = roundUp(size, offsetAlign) + fieldSize
        align = Math.max(align, offsetAlign)
      }
      result = { align, size: roundUp(size, align) }
    } else if (shape !== null) {
      const [, , vector, columns, rows, explicit, shorthand] = shape
      const base =
        explicit ??
        { f: 'f32', h: 'f16', i: 'i32', u: 'u32', b: 'bool' }[shorthand!]
      const component = layoutOf(base!).size
      const width = Number(vector ?? rows)
      const align = (width === 3 ? 4 : width) * component
      const size = width * component
      result = {
        align,
        size:
          vector === undefined ? Number(columns) * roundUp(size, align) : size,
      }
    } else if (array !== null) {
      const element = layoutOf(array[1]!)
      const count = Number(array[2]!.replace(/[iu]$/, ''))
      if (!Number.isSafeInteger(count) || count <= 0)
        throw new Error(`Unknown WGSL array length in ${written}`)
      result = {
        align: element.align,
        size: count * roundUp(element.size, element.align),
      }
    } else if (/^atomic<[iu]32>$/.test(type)) {
      result = scalar.u32!
    } else {
      throw new Error(`Unknown WGSL storage type ${written}`)
    }
    found.set(type, result)
    return result
  }
  return layoutOf
}

interface ShaderFunction {
  readonly bytes: number
  readonly refs: Set<string>
}

const declarations =
  /\b(var|let)(?:\s*<\s*(\w+)\s*>)?\s+(\w+)\s*(?::\s*([^=;]+?))?\s*(?:=\s*([^;]+))?;/g
const references = (code: string): Set<string> =>
  new Set(
    Array.from(code.matchAll(/\.\s*\w+|\b[A-Za-z_]\w*/g), ([name]) => name),
  )

function inferredType(
  expression: string,
  types: ReadonlyMap<string, string>,
): string {
  const value = expression.trim()
  const known = types.get(value)
  if (known !== undefined) return known
  if (/^(true|false)$/.test(value)) return 'bool'
  if (/^-?(?:0x[\da-fA-F]+|\d+)[iu]?$/.test(value))
    return value.endsWith('u') ? 'u32' : 'i32'
  if (/^-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?[fh]?$/.test(value))
    return value.endsWith('h') ? 'f16' : 'f32'
  const constructor = /^(\w+(?:\s*<[^()]+>)?)\s*\(/.exec(value)
  if (constructor !== null) {
    const type = constructor[1]!
    if (type === 'clamp' || type === 'array') {
      const start = constructor[0].length - 1
      const args = commaList(
        value.slice(start + 1, closingDelimiter(value, start, ')')),
      )
      if (type === 'clamp') return inferredType(args[1]!, types)
      return `array<${inferredType(args[0]!, types)}, ${args.length}>`
    }
    return type
  }
  throw new Error(`Cannot infer WGSL storage type from ${value}`)
}

export interface WgslStorage {
  readonly privateBytes: number
  /** Largest function's local storage, and its name. */
  readonly functionBytes: number
  readonly functionName: string
}

/** WebGPU lets a pipeline omit entryPoint when the module has one of its stage. */
export function wgslEntryPoint(
  source: string,
  stage: 'vertex' | 'fragment' | 'compute',
): string {
  const starts = removeComments(source).matchAll(
    new RegExp(`@${stage}\\b[^{};]*?\\bfn\\s+(\\w+)\\s*\\(`, 'g'),
  )
  const names = Array.from(starts, ([, name]) => name!)
  if (names.length !== 1)
    throw new Error(`Expected one WGSL ${stage} entry point`)
  return names[0]!
}

/**
 * Account for the emitted WGSL, including generated helper functions. Private
 * declarations count once if the entry point or one of its callees refers to
 * them. The function limit is per function, including vars in nested blocks.
 * SizeOf, not AlignOf, is what the two limits sum.
 *
 * Three emits explicit types for its mutable temporaries. The raw WGSL we
 * submit also has a few inferred forms. Unknown types fail visibly instead
 * of contributing zero. Identifier scanning assumes the generated shaders
 * keep module names distinct from locals. A shadowed name can overcount.
 */
export function wgslStorage(source: string, entryPoint: string): WgslStorage {
  const code = removeComments(source)
  const layoutOf = layouts(code)
  const globals = new Map<
    string,
    { readonly bytes: number; readonly refs: Set<string> }
  >()
  for (const [, , address, name, type, initial] of code.matchAll(
    declarations,
  )) {
    if (address !== 'private') continue
    globals.set(name!, {
      bytes: layoutOf(type ?? inferredType(initial!, new Map())).size,
      refs: references(initial ?? ''),
    })
  }

  const functions = new Map<string, ShaderFunction>()
  for (const match of code.matchAll(/\bfn\s+(\w+)\s*\(/g)) {
    const name = match[1]!
    const start = match.index + match[0].length - 1
    const paramsEnd = closingDelimiter(code, start, ')')
    const bodyStart = code.indexOf('{', paramsEnd)
    const body = code.slice(
      bodyStart + 1,
      closingDelimiter(code, bodyStart, '}'),
    )
    const types = new Map<string, string>()
    for (const parameter of commaList(code.slice(start + 1, paramsEnd))) {
      const field = /\b(\w+)\s*:\s*(.+)$/.exec(parameter)
      if (field !== null) types.set(field[1]!, field[2]!)
    }
    let bytes = 0
    for (const [, kind, , local, type, initial] of body.matchAll(
      declarations,
    )) {
      if (type !== undefined) types.set(local!, type)
      if (initial !== undefined && type === undefined && kind === 'let') {
        // Infer only on demand. Immutable bindings use no function storage.
        continue
      }
      const localType = type ?? inferLocal(initial!, types, body, local!)
      if (kind === 'var') {
        types.set(local!, localType)
        bytes += layoutOf(localType).size
      }
    }
    functions.set(name, { bytes, refs: references(body) })
  }

  if (!functions.has(entryPoint))
    throw new Error(`No WGSL entry point ${entryPoint}`)
  let privateBytes = 0
  let functionBytes = 0
  let functionName = entryPoint
  const pending = new Set([entryPoint])
  for (const name of pending) {
    const fn = functions.get(name)
    const global = globals.get(name)
    if (fn === undefined && global === undefined) continue
    if (fn !== undefined && fn.bytes > functionBytes) {
      functionName = name
      functionBytes = fn.bytes
    }
    if (global !== undefined) privateBytes += global.bytes
    for (const ref of fn?.refs ?? global!.refs)
      if (globals.has(ref) || functions.has(ref)) pending.add(ref)
  }
  return { privateBytes, functionBytes, functionName }
}

function inferLocal(
  initial: string,
  types: Map<string, string>,
  body: string,
  local: string,
): string {
  const name = initial.trim()
  if (/^\w+$/.test(name) && !types.has(name)) {
    for (const [, kind, , binding, type, value] of body.matchAll(
      declarations,
    )) {
      if (binding === local) break
      if (kind === 'let' && binding === name && value !== undefined) {
        types.set(name, type ?? inferredType(value, types))
        break
      }
    }
  }
  return inferredType(initial, types)
}
