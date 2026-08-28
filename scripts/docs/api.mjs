import { renderFragment } from './markdown.mjs'
import { escapeAttribute } from './highlight.mjs'
import { DOCS } from './routes.mjs'

/*
 * TypeDoc's reflection tree, as pages this site draws itself.
 *
 * **Why the JSON rather than a theme.** TypeDoc can render HTML and can be
 * given a custom theme, and that is the shorter road to an API reference that
 * is nearly the right colour. It is the wrong road here for one structural
 * reason: a themed TypeDoc site is a *second site*. It has its own navigation,
 * its own search, its own page shell and its own idea of what a link is, and
 * embedding it means a reader crossing from `Concepts` into `Reference` leaves
 * the masthead, the wing rail and the router behind. The serialized reflection
 * tree is the complete model — every signature, every comment part, every
 * resolved cross-reference and every source position — so rendering it here
 * costs a type printer and buys one site.
 *
 * **What a page is.** Three levels, which is TypeDoc's own division and is
 * right for the same reason it is right there:
 *
 *   /docs/api                    the twelve packages, and the layering
 *   /docs/api/spatial            one package: every export, as a summary row
 *   /docs/api/spatial/Sector     one export, in full
 *
 * The alternative — one page per package with all two hundred and twenty-eight
 * of `universe`'s exports on it — is a three hundred kilobyte document nobody
 * can scan and every cross-reference lands in the middle of.
 */

/* TypeDoc's `ReflectionKind` bit flags, named. */
const KIND = {
  module: 2,
  namespace: 4,
  enum: 8,
  enumMember: 16,
  variable: 32,
  function: 64,
  class: 128,
  interface: 256,
  constructor: 512,
  property: 1024,
  method: 2048,
  callSignature: 4096,
  indexSignature: 8192,
  constructorSignature: 16384,
  parameter: 32768,
  typeLiteral: 65536,
  typeParameter: 131072,
  accessor: 262144,
  getSignature: 524288,
  setSignature: 1048576,
  typeAlias: 2097152,
  reference: 4194304,
}

/** What a reader calls each kind, singular and plural. */
const KIND_LABEL = new Map([
  [KIND.class, ['Class', 'Classes']],
  [KIND.interface, ['Interface', 'Interfaces']],
  [KIND.function, ['Function', 'Functions']],
  [KIND.typeAlias, ['Type', 'Types']],
  [KIND.variable, ['Constant', 'Constants']],
  [KIND.enum, ['Enum', 'Enums']],
  [KIND.namespace, ['Namespace', 'Namespaces']],
  [KIND.reference, ['Re-export', 'Re-exports']],
])

/** The order a package's exports are grouped in. Types before the values. */
const GROUP_ORDER = [
  KIND.class,
  KIND.interface,
  KIND.typeAlias,
  KIND.enum,
  KIND.function,
  KIND.variable,
  KIND.namespace,
  KIND.reference,
]

/**
 * Everything the reference wing needs, from one parsed `api.json`.
 *
 * Returns the wing's navigation groups and the pages behind them. Nothing is
 * written here — `build.mjs` owns the filesystem, so this stays a pure function
 * of the reflection tree and can be reasoned about without one.
 */
export function buildReference(project, described = new Map()) {
  const byId = new Map()
  index(project, byId)

  const packages = (project.children ?? [])
    .filter((child) => child.kind === KIND.module)
    .map((module) => ({
      module,
      short: shortName(module.name),
      route: `${DOCS}/api/${shortName(module.name)}`,
      /* The sentence in the package's own manifest. See `packageDescriptions`
         in `build.mjs` for why it does not come out of the reflection. */
      description: described.get(module.name) ?? '',
    }))

  /*
   * Where every documented reflection lives, resolved before anything is
   * rendered.
   *
   * The type printer reaches a reference to `UniverseVector` while rendering
   * `packages/simulation`, and the only way it can turn that into a link is if
   * the address of every export in every package is already known. That is what
   * the passes below are for, and it is why rendering can then be a pure
   * function of one reflection.
   *
   * Three of them, in falling order of authority, each declining to overwrite
   * what an earlier one claimed.
   *
   * The order is what makes a link land where a reader expects. A package's
   * `index.ts` re-exports `UniverseVector`, so the module's child is a
   * *reference* with its own id, and the declaration it points at has another —
   * and that second id is what every type expression in every other package
   * actually names. It is also reachable as a member of the `UV` namespace that
   * groups the vector helpers. Registered in one pass with the namespace's
   * members last, `UniverseVector` in a signature linked to
   * `/docs/api/spatial/UV#universevector`, which is the type's own name pointing
   * at somebody else's page.
   */
  const addresses = new Map()
  for (const { module, route } of packages) {
    addresses.set(module.id, route)
    for (const child of module.children ?? [])
      addresses.set(child.id, `${route}/${child.name}`)
  }
  for (const { module, route } of packages)
    for (const child of module.children ?? []) {
      const target = resolveReference(child, { byId })
      if (!addresses.has(target.id))
        addresses.set(target.id, `${route}/${child.name}`)
    }
  for (const { module, route } of packages)
    for (const child of module.children ?? []) {
      // A member — a method, a property, an accessor — is an anchor on its
      // owner's page rather than a page of its own. There are 1,063 properties
      // in this tree, and a page each is a reference nobody can hold in their
      // head and eight hundred more files to fetch one at a time.
      const target = resolveReference(child, { byId })
      for (const member of target.children ?? [])
        if (!addresses.has(member.id))
          addresses.set(
            member.id,
            `${route}/${child.name}#${anchorFor(member)}`,
          )
    }

  const context = { byId, addresses }
  const pages = []

  pages.push(indexPage(packages, context))
  for (const entry of packages) {
    pages.push(packagePage(entry, context))
    for (const child of entry.module.children ?? [])
      pages.push(memberPage(entry, child, context))
  }

  const groups = packages.map((entry) => ({
    label: entry.short,
    pages: (entry.module.children ?? [])
      .slice()
      .sort(byKindThenName)
      .map((child) => `${entry.route}/${child.name}`),
    /* The package's own page heads its group in the rail — it is the thing the
       group is named after, not a sibling of its exports. */
    head: entry.route,
  }))

  return { pages, groups }
}

/* ------------------------------------------------------------------------- */
/* Pages                                                                      */
/* ------------------------------------------------------------------------- */

function indexPage(packages, context) {
  const rows = packages
    .map((entry) => {
      const summary =
        commentHtml(entry.module.comment, context) ||
        (entry.description === ''
          ? ''
          : `<p>${escapeHtml(entry.description)}</p>`)
      const count = (entry.module.children ?? []).length
      return (
        `<a class="api-row" href="${entry.route}" data-internal>` +
        `<span class="api-row-name">${escapeHtml(entry.short)}</span>` +
        `<span class="api-row-body">${summary}</span>` +
        `<span class="api-row-count">${count}</span></a>`
      )
    })
    .join('')

  return {
    route: `${DOCS}/api`,
    title: 'Reference',
    lead: `Every export of the ${packages.length} engine packages, generated from the source and its comments.`,
    kind: 'api-index',
    html: `<div class="api-rows">${rows}</div>`,
    headings: packages.map((entry) => ({
      id: entry.short,
      text: entry.short,
      depth: 2,
    })),
    words: 0,
    diagrams: 0,
    text: packages.map((entry) => entry.short).join(' '),
  }
}

function packagePage({ module, short, route, description }, context) {
  const children = (module.children ?? []).slice().sort(byKindThenName)
  const grouped = new Map()
  for (const child of children) {
    const kind = child.kind
    if (!grouped.has(kind)) grouped.set(kind, [])
    grouped.get(kind).push(child)
  }

  const headings = []
  let html =
    commentHtml(module.comment, context) ||
    (description === '' ? '' : `<p>${escapeHtml(description)}</p>`)

  for (const kind of GROUP_ORDER) {
    const members = grouped.get(kind)
    if (members === undefined) continue
    const [, plural] = KIND_LABEL.get(kind) ?? ['', 'Other']
    const id = slug(plural)
    headings.push({ id, text: plural, depth: 2 })
    html +=
      `<h2 id="${id}" class="doc-h"><a href="#${id}" class="doc-anchor">${plural}</a></h2>` +
      `<div class="api-rows">` +
      members
        .map((member) => {
          const target = `${route}/${member.name}`
          const line = firstSentence(member.comment)
          /* No kind on the row: it is grouped under a heading that says
             `Interfaces`, and a column repeating `INTERFACE` fourteen times
             under it is a column carrying no information. The index keeps its
             count column, which does. */
          return (
            `<a class="api-row" href="${target}" data-internal>` +
            `<span class="api-row-name">${escapeHtml(member.name)}</span>` +
            `<span class="api-row-body">${line}</span></a>`
          )
        })
        .join('') +
      `</div>`
  }

  return {
    route,
    title: short,
    lead:
      plainSummary(module.comment) ||
      description ||
      `${children.length} exports from ${module.name}.`,
    kind: 'api-package',
    packageName: module.name,
    html,
    headings,
    words: 0,
    diagrams: 0,
    text: `${module.name} ${children.map((child) => child.name).join(' ')}`,
  }
}

function memberPage({ short, route }, reflection, context) {
  const target = resolveReference(reflection, context)
  const headings = []
  const parts = []

  parts.push(
    `<div class="api-signature">${declarationHtml(target, context)}</div>`,
  )
  parts.push(commentHtml(target.comment, context))
  parts.push(sourceHtml(target))

  const signatures = target.signatures ?? []
  if (signatures.length > 0) parts.push(signaturesHtml(signatures, context))

  if (target.kind === KIND.typeAlias && target.type !== undefined)
    parts.push(
      `<h2 id="type" class="doc-h"><a href="#type" class="doc-anchor">Type</a></h2>` +
        `<div class="api-signature">${typeHtml(target.type, context)}</div>`,
    )

  // A class or an interface is its members. Constructors first, then
  // properties, then methods — the order somebody reads a type in.
  const members = (target.children ?? []).slice().sort(byMemberOrder)
  if (members.length > 0) {
    headings.push({ id: 'members', text: 'Members', depth: 2 })
    parts.push(
      `<h2 id="members" class="doc-h"><a href="#members" class="doc-anchor">Members</a></h2>`,
    )
    for (const member of members) {
      const id = anchorFor(member)
      headings.push({ id, text: member.name, depth: 3 })
      parts.push(memberHtml(member, id, context))
    }
  }

  return {
    route: `${route}/${reflection.name}`,
    title: reflection.name,
    lead:
      plainSummary(target.comment) ||
      `${(KIND_LABEL.get(target.kind) ?? ['Export'])[0]} in @inertialref/${short}.`,
    kind: 'api-member',
    packageName: `@inertialref/${short}`,
    memberKind: (KIND_LABEL.get(target.kind) ?? ['Export'])[0],
    html: parts.filter((part) => part !== '').join('\n'),
    headings,
    words: 0,
    diagrams: 0,
    text: `${reflection.name} ${plainSummary(target.comment)}`,
  }
}

/* ------------------------------------------------------------------------- */
/* Declarations                                                               */
/* ------------------------------------------------------------------------- */

/** The one line a reader looks at first: what this is, spelled as TypeScript. */
function declarationHtml(reflection, context) {
  const name = `<span class="t-name">${escapeHtml(reflection.name)}</span>`
  const generics = typeParametersHtml(reflection.typeParameters, context)

  switch (reflection.kind) {
    case KIND.class:
    case KIND.interface: {
      const keyword = reflection.kind === KIND.class ? 'class' : 'interface'
      const extended = (reflection.extendedTypes ?? [])
        .map((type) => typeHtml(type, context))
        .join(`<span class="t-punct">, </span>`)
      return (
        kw(keyword) +
        ' ' +
        name +
        generics +
        (extended === '' ? '' : ` ${kw('extends')} ${extended}`)
      )
    }
    case KIND.typeAlias:
      return `${kw('type')} ${name}${generics}`
    case KIND.enum:
      return `${kw('enum')} ${name}`
    case KIND.function:
      return `${kw('function')} ${name}`
    case KIND.variable:
      return (
        kw(reflection.flags?.isConst === false ? 'let' : 'const') +
        ' ' +
        name +
        (reflection.type === undefined
          ? ''
          : `<span class="t-punct">: </span>${typeHtml(reflection.type, context)}`)
      )
    case KIND.namespace:
      return `${kw('namespace')} ${name}`
    default:
      return name
  }
}

function signaturesHtml(signatures, context) {
  return signatures
    .map((signature) => {
      const params = (signature.parameters ?? [])
        .map((parameter) => parameterRow(parameter, context))
        .join('')
      const returns =
        signature.type === undefined
          ? ''
          : `<div class="api-returns"><span class="api-term">Returns</span>` +
            `<span class="api-type">${typeHtml(signature.type, context)}</span></div>`
      return (
        `<div class="api-overload">` +
        `<div class="api-signature">${signatureHtml(signature, context)}</div>` +
        commentHtml(signature.comment, context) +
        (params === '' ? '' : `<dl class="api-params">${params}</dl>`) +
        returns +
        `</div>`
      )
    })
    .join('')
}

function signatureHtml(signature, context) {
  const params = (signature.parameters ?? [])
    .map((parameter) => {
      const rest = parameter.flags?.isRest === true ? '…' : ''
      const optional = parameter.flags?.isOptional === true ? '?' : ''
      return (
        `<span class="t-param">${rest}${escapeHtml(parameter.name)}${optional}</span>` +
        `<span class="t-punct">: </span>` +
        (parameter.type === undefined
          ? kw('unknown')
          : typeHtml(parameter.type, context))
      )
    })
    .join(`<span class="t-punct">, </span>`)
  const returns =
    signature.type === undefined
      ? ''
      : `<span class="t-punct"> → </span>${typeHtml(signature.type, context)}`
  /* An anonymous call signature has no name of its own to print: TypeDoc calls
     it `__type`, and a member's page has already printed the member's. */
  const name =
    signature.name === '__type' || signature.name === ''
      ? ''
      : `<span class="t-name">${escapeHtml(signature.name)}</span>`
  return (
    name +
    typeParametersHtml(signature.typeParameters, context) +
    `<span class="t-punct">(</span>${params}<span class="t-punct">)</span>${returns}`
  )
}

function parameterRow(parameter, context) {
  const doc = commentHtml(parameter.comment, context)
  return (
    `<div class="api-param">` +
    `<dt><span class="t-param">${escapeHtml(parameter.name)}</span>` +
    `<span class="api-type">${parameter.type === undefined ? '' : typeHtml(parameter.type, context)}</span></dt>` +
    `<dd>${doc === '' ? '<span class="api-undocumented">Undocumented</span>' : doc}</dd>` +
    `</div>`
  )
}

function memberHtml(member, id, context) {
  const signatures =
    member.signatures ??
    (member.getSignature === undefined ? [] : [member.getSignature])
  const head =
    signatures.length > 0
      ? signatures
          .map(
            (signature) =>
              `<div class="api-signature">` +
              `<span class="t-name">${escapeHtml(member.name)}</span>` +
              signatureHtml({ ...signature, name: '' }, context) +
              `</div>`,
          )
          .join('')
      : `<div class="api-signature">` +
        `<span class="t-name">${escapeHtml(member.name)}</span>` +
        (member.flags?.isOptional === true
          ? `<span class="t-punct">?</span>`
          : '') +
        `<span class="t-punct">: </span>` +
        (member.type === undefined
          ? kw('unknown')
          : typeHtml(member.type, context)) +
        `</div>`

  const badges = [
    member.flags?.isStatic === true ? 'static' : '',
    member.flags?.isReadonly === true ? 'readonly' : '',
    member.kind === KIND.accessor ? 'accessor' : '',
  ]
    .filter((badge) => badge !== '')
    .map((badge) => `<span class="api-flag">${badge}</span>`)
    .join('')

  const doc =
    commentHtml(member.comment, context) ||
    signatures
      .map((signature) => commentHtml(signature.comment, context))
      .join('')

  const params = signatures
    .flatMap((signature) => signature.parameters ?? [])
    .map((parameter) => parameterRow(parameter, context))
    .join('')

  return (
    `<section class="api-member" id="${escapeAttribute(id)}">` +
    `<h3 class="doc-h"><a href="#${escapeAttribute(id)}" class="doc-anchor">${escapeHtml(member.name)}</a>${badges}</h3>` +
    head +
    doc +
    (params === '' ? '' : `<dl class="api-params">${params}</dl>`) +
    `</section>`
  )
}

function sourceHtml(reflection) {
  const source = (reflection.sources ?? [])[0]
  if (source === undefined || source.url === undefined) return ''
  return (
    `<a class="api-source" href="${escapeAttribute(source.url)}" target="_blank" rel="noreferrer">` +
    `${escapeHtml(source.fileName)}:${source.line}</a>`
  )
}

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * A type expression, as marked-up TypeScript.
 *
 * Every variant TypeDoc can serialize is handled, and the default arm is a
 * question mark rather than a throw: a type this printer has not met is a
 * signature rendered slightly poorly, and a build that fell over for one would
 * take the other eight hundred pages with it.
 *
 * References to documented reflections become links. That is the single thing
 * this whole file exists for — a signature you can read is worth a great deal
 * less than a signature you can *follow*, and it is what an embedded reference
 * generated somewhere else cannot do into a site it does not know about.
 */
function typeHtml(type, context) {
  if (type === undefined || type === null) return kw('unknown')
  switch (type.type) {
    case 'intrinsic':
      return kw(type.name)
    case 'literal':
      return `<span class="t-lit">${escapeHtml(
        typeof type.value === 'string' ? `'${type.value}'` : String(type.value),
      )}</span>`
    case 'reference': {
      const address = context.addresses.get(type.target)
      const args =
        (type.typeArguments ?? []).length === 0
          ? ''
          : `<span class="t-punct">&lt;</span>` +
            type.typeArguments
              .map((argument) => typeHtml(argument, context))
              .join(`<span class="t-punct">, </span>`) +
            `<span class="t-punct">&gt;</span>`
      const name = escapeHtml(type.name)
      return address === undefined
        ? `<span class="t-ref">${name}</span>${args}`
        : `<a class="t-ref t-link" href="${escapeAttribute(address)}" data-internal>${name}</a>${args}`
    }
    case 'array':
      return `${typeHtml(type.elementType, context)}<span class="t-punct">[]</span>`
    case 'union':
      return type.types
        .map((member) => typeHtml(member, context))
        .join(`<span class="t-punct"> | </span>`)
    case 'intersection':
      return type.types
        .map((member) => typeHtml(member, context))
        .join(`<span class="t-punct"> &amp; </span>`)
    case 'tuple':
      return (
        `<span class="t-punct">[</span>` +
        (type.elements ?? [])
          .map((element) => typeHtml(element, context))
          .join(`<span class="t-punct">, </span>`) +
        `<span class="t-punct">]</span>`
      )
    case 'namedTupleMember':
      return (
        `<span class="t-param">${escapeHtml(type.name)}</span>` +
        `<span class="t-punct">: </span>${typeHtml(type.element, context)}`
      )
    case 'typeOperator':
      return `${kw(type.operator)} ${typeHtml(type.target, context)}`
    case 'indexedAccess':
      return (
        `${typeHtml(type.objectType, context)}<span class="t-punct">[</span>` +
        `${typeHtml(type.indexType, context)}<span class="t-punct">]</span>`
      )
    case 'query':
      return `${kw('typeof')} ${typeHtml(type.queryType, context)}`
    case 'predicate':
      return (
        (type.asserts === true ? `${kw('asserts')} ` : '') +
        `<span class="t-param">${escapeHtml(type.name)}</span>` +
        (type.targetType === undefined
          ? ''
          : ` ${kw('is')} ${typeHtml(type.targetType, context)}`)
      )
    case 'conditional':
      return (
        `${typeHtml(type.checkType, context)} ${kw('extends')} ${typeHtml(type.extendsType, context)}` +
        `<span class="t-punct"> ? </span>${typeHtml(type.trueType, context)}` +
        `<span class="t-punct"> : </span>${typeHtml(type.falseType, context)}`
      )
    case 'rest':
      return `<span class="t-punct">…</span>${typeHtml(type.elementType, context)}`
    case 'optional':
      return `${typeHtml(type.elementType, context)}<span class="t-punct">?</span>`
    case 'templateLiteral':
      return `<span class="t-lit">\`…\`</span>`
    case 'inferred':
      return `${kw('infer')} <span class="t-ref">${escapeHtml(type.name)}</span>`
    case 'mapped':
      return `<span class="t-punct">{ </span>${kw('in')}<span class="t-punct"> }</span>`
    case 'reflection':
      return reflectionTypeHtml(type.declaration, context)
    default:
      return `<span class="t-ref">${escapeHtml(type.name ?? 'unknown')}</span>`
  }
}

/**
 * An inline object or function type.
 *
 * Collapsed past four members. A `Placement` inline in a signature is worth
 * reading; the whole of a fourteen-field options bag inline in one is a
 * signature that has become a paragraph, and the fields are on the page it
 * links to anyway.
 */
function reflectionTypeHtml(declaration, context) {
  if (declaration === undefined) return kw('object')
  const signatures = declaration.signatures ?? []
  if (signatures.length > 0)
    return signatures
      .map((signature) =>
        signatureHtml({ ...signature, name: '__type' }, context),
      )
      .join(`<span class="t-punct"> | </span>`)

  const children = declaration.children ?? []
  if (children.length === 0) return kw('object')
  if (children.length > 4)
    return `<span class="t-punct">{ </span><span class="t-ref">${children.length} fields</span><span class="t-punct"> }</span>`
  return (
    `<span class="t-punct">{ </span>` +
    children
      .map(
        (child) =>
          `<span class="t-param">${escapeHtml(child.name)}</span>` +
          (child.flags?.isOptional === true
            ? `<span class="t-punct">?</span>`
            : '') +
          `<span class="t-punct">: </span>${typeHtml(child.type, context)}`,
      )
      .join(`<span class="t-punct">; </span>`) +
    `<span class="t-punct"> }</span>`
  )
}

function typeParametersHtml(parameters, context) {
  if (parameters === undefined || parameters.length === 0) return ''
  return (
    `<span class="t-punct">&lt;</span>` +
    parameters
      .map(
        (parameter) =>
          `<span class="t-ref">${escapeHtml(parameter.name)}</span>` +
          (parameter.type === undefined
            ? ''
            : ` ${kw('extends')} ${typeHtml(parameter.type, context)}`),
      )
      .join(`<span class="t-punct">, </span>`) +
    `<span class="t-punct">&gt;</span>`
  )
}

/* ------------------------------------------------------------------------- */
/* Comments                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * A doc comment, as HTML, through the same markdown renderer every page uses.
 *
 * Parts are flattened back into markdown before being rendered rather than
 * being turned into HTML one at a time, which looks like a detour and is not:
 * a comment's prose is markdown *across* the parts — a list can start in one
 * text part, contain a `{@link}` and finish in the next — so rendering part by
 * part produces three fragments where the author wrote one list.
 */
function commentHtml(comment, context) {
  if (comment === undefined) return ''
  const summary = partsToMarkdown(comment.summary ?? [], context)
  const blocks = (comment.blockTags ?? [])
    .filter((tag) => !DROPPED_TAGS.has(tag.tag))
    .map((tag) => {
      const body = partsToMarkdown(tag.content ?? [], context)
      if (tag.tag === '@example')
        return `<div class="api-example"><span class="api-term">Example</span>${renderFragment(body, ROOT)}</div>`
      const label = TAG_LABEL.get(tag.tag) ?? tag.tag.replace(/^@/, '')
      return `<div class="api-note"><span class="api-term">${escapeHtml(label)}</span>${renderFragment(body, ROOT)}</div>`
    })
    .join('')
  const prose = summary.trim() === '' ? '' : renderFragment(summary, ROOT)
  return prose + blocks
}

/** Tags the reference renders itself, or that are not for the reader. */
const DROPPED_TAGS = new Set(['@param', '@returns', '@internal', '@hidden'])

const TAG_LABEL = new Map([
  ['@remarks', 'Remarks'],
  ['@defaultValue', 'Default'],
  ['@throws', 'Throws'],
  ['@see', 'See also'],
  ['@deprecated', 'Deprecated'],
  ['@typeParam', 'Type parameter'],
])

/**
 * The repository-root context every comment's links resolve against.
 *
 * A doc comment naming `docs/design/galaxy.md` means the path from the root —
 * `routes.mjs` explains why, and this is the pseudo-path that gives it that
 * reading.
 */
const ROOT = 'index.md'

function partsToMarkdown(parts, context) {
  return parts
    .map((part) => {
      if (part.kind === 'text') return part.text
      if (part.kind === 'code') return part.text
      if (part.kind !== 'inline-tag') return part.text ?? ''
      const label = part.tsLinkText ?? part.text
      if (typeof part.target === 'number') {
        const address = context.addresses.get(part.target)
        return address === undefined ? `\`${label}\`` : `[${label}](${address})`
      }
      if (typeof part.target === 'string') return `[${label}](${part.target})`
      return `\`${label}\``
    })
    .join('')
}

/** The first sentence of a summary, for a row in a list. */
function firstSentence(comment) {
  const text = plainSummary(comment)
  if (text === '') return ''
  const stop = text.search(/\.\s|\.$/)
  const sentence = stop === -1 ? text : text.slice(0, stop + 1)
  return escapeHtml(
    sentence.length > 180 ? `${sentence.slice(0, 179)}…` : sentence,
  )
}

function plainSummary(comment) {
  if (comment === undefined) return ''
  return (comment.summary ?? [])
    .map((part) =>
      part.kind === 'inline-tag' ? (part.tsLinkText ?? part.text) : part.text,
    )
    .join('')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------------------------------------------------------- */
/* Odds and ends                                                              */
/* ------------------------------------------------------------------------- */

function index(node, into) {
  into.set(node.id, node)
  for (const child of node.children ?? []) index(child, into)
  for (const signature of node.signatures ?? []) index(signature, into)
}

/** A re-export points at the thing it re-exports; everything else is itself. */
function resolveReference(reflection, context) {
  if (reflection.kind !== KIND.reference) return reflection
  return context.byId.get(reflection.target) ?? reflection
}

const shortName = (name) => name.replace(/^@inertialref\//, '')

const byKindThenName = (a, b) => {
  const order = GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind)
  return order !== 0 ? order : a.name.localeCompare(b.name)
}

/* Constructors, then properties, then everything callable. */
const MEMBER_ORDER = [
  KIND.constructor,
  KIND.property,
  KIND.accessor,
  KIND.method,
]
const byMemberOrder = (a, b) => {
  const order = MEMBER_ORDER.indexOf(a.kind) - MEMBER_ORDER.indexOf(b.kind)
  return order !== 0 ? order : a.name.localeCompare(b.name)
}

const anchorFor = (member) => slug(member.name)

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

const kw = (word) => `<span class="t-kw">${escapeHtml(word)}</span>`

const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
