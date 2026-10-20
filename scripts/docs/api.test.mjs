import { describe, expect, it } from 'vitest'
import { buildReference, canonicalReferenceLinks } from './api.mjs'

const project = {
  id: 0,
  name: 'InertialRef',
  children: [
    {
      id: 1,
      name: '@inertialref/spatial',
      kind: 2,
      children: [
        {
          id: 2,
          name: 'Vec3',
          kind: 256,
          children: [
            {
              id: 4,
              name: 'x',
              kind: 1024,
              type: { type: 'intrinsic', name: 'number' },
            },
          ],
        },
        {
          id: 3,
          name: 'vec3',
          kind: 64,
          signatures: [
            {
              id: 5,
              name: 'vec3',
              kind: 4096,
              type: { type: 'reference', name: 'Vec3', target: 2 },
            },
          ],
          comment: {
            summary: [
              { kind: 'text', text: 'Read ' },
              { kind: 'inline-tag', tag: '@link', text: 'x', target: 4 },
              { kind: 'text', text: ' and ' },
              { kind: 'inline-tag', tag: '@link', text: 'Vec3', target: 2 },
              { kind: 'text', text: '.' },
            ],
          },
        },
        {
          id: 6,
          name: 'Unique',
          kind: 2097152,
          type: { type: 'intrinsic', name: 'number' },
        },
      ],
    },
    {
      id: 7,
      name: '@inertialref/shared',
      kind: 2,
      children: [{ id: 8, name: 'Vector', kind: 4194304, target: 2 }],
    },
  ],
}

const byTitle = (reference, title) =>
  reference.pages.find((page) => page.title === title)

describe('API routes on case-insensitive filesystems', () => {
  it('keeps every exported symbol in a distinct HTML file', () => {
    const reference = buildReference(project)
    const files = reference.pages.map((page) =>
      `${page.route}.html`.toLowerCase(),
    )
    expect(new Set(files).size).toBe(files.length)
    expect(byTitle(reference, 'Unique').route).toBe('/docs/api/spatial/Unique')
    expect(byTitle(reference, 'Vec3').route).toMatch(/\/Vec3-[a-f0-9]+$/)
    expect(byTitle(reference, 'vec3').route).toMatch(/\/vec3-[a-f0-9]+$/)
  })

  it('keeps old exact-case addresses as aliases without duplicating pages', () => {
    const reference = buildReference(project)
    expect(reference.aliases).toEqual({
      '/docs/api/spatial/Vec3': byTitle(reference, 'Vec3').route,
      '/docs/api/spatial/vec3': byTitle(reference, 'vec3').route,
    })
    const routes = new Set(reference.pages.map((page) => page.route))
    for (const [alias, target] of Object.entries(reference.aliases)) {
      expect(routes.has(alias)).toBe(false)
      expect(routes.has(target)).toBe(true)
    }
    expect(reference.pages).toHaveLength(7)
  })

  it('uses the canonical address in navigation, signatures, comments and member anchors', () => {
    const reference = buildReference(project)
    const type = byTitle(reference, 'Vec3')
    const fn = byTitle(reference, 'vec3')
    expect(reference.groups[0].pages).toContain(type.route)
    expect(reference.groups[0].pages).toContain(fn.route)
    expect(byTitle(reference, 'spatial').html).toContain(`href="${type.route}"`)
    expect(byTitle(reference, 'spatial').html).toContain(`href="${fn.route}"`)
    expect(fn.html).toContain(`href="${type.route}"`)
    expect(fn.html).toContain(`href="${type.route}#x"`)
  })

  it('rewrites explicit links while preserving fragments and query parameters', () => {
    const reference = buildReference(project)
    const type = byTitle(reference, 'Vec3')
    expect(
      canonicalReferenceLinks(
        '<a href="/docs/api/spatial/Vec3?reader=1#x">Vec3</a>',
        reference.aliases,
      ),
    ).toBe(`<a href="${type.route}?reader=1#x">Vec3</a>`)
    expect(
      canonicalReferenceLinks(
        '<a href="/docs/api/spatial/Unique">Unique</a>',
        reference.aliases,
      ),
    ).toBe('<a href="/docs/api/spatial/Unique">Unique</a>')
  })

  it('keeps routes stable when TypeDoc visits declarations in another order', () => {
    const reversed = structuredClone(project)
    reversed.children.reverse()
    for (const module of reversed.children) module.children.reverse()
    const first = buildReference(project)
    const second = buildReference(reversed)
    expect(second.aliases).toEqual(first.aliases)
    expect(second.pages.map((page) => page.route).sort()).toEqual(
      first.pages.map((page) => page.route).sort(),
    )
    expect(byTitle(second, 'vec3').html).toBe(byTitle(first, 'vec3').html)
  })
})

/*
 * One type alias per TypeDoc type kind, each rendered on its own page. A
 * reference to `Point` resolves to a link; one to `Map` has no address and
 * stays text.
 */
const number = { type: 'intrinsic', name: 'number' }
const string = { type: 'intrinsic', name: 'string' }
const point = { type: 'reference', name: 'Point', target: 11 }
const kinds = {
  array: { type: 'array', elementType: number },
  conditional: {
    type: 'conditional',
    checkType: { type: 'reference', name: 'T' },
    extendsType: string,
    trueType: { type: 'literal', value: 1 },
    falseType: { type: 'literal', value: null },
  },
  indexedAccess: {
    type: 'indexedAccess',
    objectType: point,
    indexType: { type: 'literal', value: 'x' },
  },
  inferred: { type: 'inferred', name: 'U' },
  intersection: {
    type: 'intersection',
    types: [point, { type: 'reference', name: 'Tagged' }],
  },
  intrinsic: number,
  literal: { type: 'literal', value: 'north' },
  mapped: {
    type: 'mapped',
    parameter: 'K',
    parameterType: string,
    templateType: number,
  },
  namedTupleMember: {
    type: 'namedTupleMember',
    name: 'radius',
    isOptional: false,
    element: number,
  },
  optional: { type: 'optional', elementType: string },
  predicate: {
    type: 'predicate',
    name: 'value',
    asserts: true,
    targetType: point,
  },
  query: {
    type: 'query',
    queryType: { type: 'reference', name: 'origin', target: 11 },
  },
  reference: {
    type: 'reference',
    name: 'Map',
    target: 999,
    typeArguments: [string, point],
  },
  reflection: {
    type: 'reflection',
    declaration: {
      id: 30,
      name: '__type',
      kind: 65536,
      children: [
        { id: 31, name: 'x', kind: 1024, type: number },
        {
          id: 32,
          name: 'label',
          kind: 1024,
          flags: { isOptional: true },
          type: string,
        },
      ],
    },
  },
  rest: { type: 'rest', elementType: { type: 'array', elementType: string } },
  templateLiteral: {
    type: 'templateLiteral',
    head: 'id-',
    tail: [[number, '']],
  },
  tuple: {
    type: 'tuple',
    elements: [
      number,
      {
        type: 'namedTupleMember',
        name: 'y',
        isOptional: false,
        element: number,
      },
    ],
  },
  typeOperator: { type: 'typeOperator', operator: 'keyof', target: point },
  union: {
    type: 'union',
    types: [
      { type: 'literal', value: 'a' },
      { type: 'literal', value: 2 },
      { type: 'intrinsic', name: 'undefined' },
    ],
  },
  unknown: { type: 'unknown', name: 'import("three").Vector3' },
}
const kindsProject = {
  id: 0,
  name: 'InertialRef',
  children: [
    {
      id: 10,
      name: '@inertialref/kinds',
      kind: 2,
      children: [
        { id: 11, name: 'Point', kind: 256, children: [] },
        ...Object.entries(kinds).map(([kind, type], i) => ({
          id: 100 + i,
          name: kind,
          kind: 2097152,
          type,
        })),
      ],
    },
  ],
}

/** The HTML under a type alias page's "Type" heading. */
const aliasTypeHtml = (reference, title) =>
  byTitle(reference, title).html.match(
    /<h2 id="type"[^]*?<div class="api-signature">([^]*?)<\/div>/,
  )[1]

const goldens = [
  ['array', '<span class="t-kw">number</span><span class="t-punct">[]</span>'],
  [
    'conditional',
    '<span class="t-ref">T</span> <span class="t-kw">extends</span> <span class="t-kw">string</span><span class="t-punct"> ? </span><span class="t-lit">1</span><span class="t-punct"> : </span><span class="t-lit">null</span>',
  ],
  [
    'indexedAccess',
    '<a class="t-ref t-link" href="/docs/api/kinds/Point" data-internal>Point</a><span class="t-punct">[</span><span class="t-lit">\'x\'</span><span class="t-punct">]</span>',
  ],
  ['inferred', '<span class="t-kw">infer</span> <span class="t-ref">U</span>'],
  [
    'intersection',
    '<a class="t-ref t-link" href="/docs/api/kinds/Point" data-internal>Point</a><span class="t-punct"> &amp; </span><span class="t-ref">Tagged</span>',
  ],
  ['intrinsic', '<span class="t-kw">number</span>'],
  ['literal', '<span class="t-lit">\'north\'</span>'],
  [
    'mapped',
    '<span class="t-punct">{ </span><span class="t-kw">in</span><span class="t-punct"> }</span>',
  ],
  [
    'namedTupleMember',
    '<span class="t-param">radius</span><span class="t-punct">: </span><span class="t-kw">number</span>',
  ],
  [
    'optional',
    '<span class="t-kw">string</span><span class="t-punct">?</span>',
  ],
  [
    'predicate',
    '<span class="t-kw">asserts</span> <span class="t-param">value</span> <span class="t-kw">is</span> <a class="t-ref t-link" href="/docs/api/kinds/Point" data-internal>Point</a>',
  ],
  [
    'query',
    '<span class="t-kw">typeof</span> <a class="t-ref t-link" href="/docs/api/kinds/Point" data-internal>origin</a>',
  ],
  [
    'reference',
    '<span class="t-ref">Map</span><span class="t-punct">&lt;</span><span class="t-kw">string</span><span class="t-punct">, </span><a class="t-ref t-link" href="/docs/api/kinds/Point" data-internal>Point</a><span class="t-punct">&gt;</span>',
  ],
  [
    'reflection',
    '<span class="t-punct">{ </span><span class="t-param">x</span><span class="t-punct">: </span><span class="t-kw">number</span><span class="t-punct">; </span><span class="t-param">label</span><span class="t-punct">?</span><span class="t-punct">: </span><span class="t-kw">string</span><span class="t-punct"> }</span>',
  ],
  [
    'rest',
    '<span class="t-punct">…</span><span class="t-kw">string</span><span class="t-punct">[]</span>',
  ],
  ['templateLiteral', '<span class="t-lit">`…`</span>'],
  [
    'tuple',
    '<span class="t-punct">[</span><span class="t-kw">number</span><span class="t-punct">, </span><span class="t-param">y</span><span class="t-punct">: </span><span class="t-kw">number</span><span class="t-punct">]</span>',
  ],
  [
    'typeOperator',
    '<span class="t-kw">keyof</span> <a class="t-ref t-link" href="/docs/api/kinds/Point" data-internal>Point</a>',
  ],
  [
    'union',
    '<span class="t-lit">\'a\'</span><span class="t-punct"> | </span><span class="t-lit">2</span><span class="t-punct"> | </span><span class="t-kw">undefined</span>',
  ],
  ['unknown', '<span class="t-ref">import(&quot;three&quot;).Vector3</span>'],
]

describe('API type printer', () => {
  it('has a golden for every kind in the inline project', () => {
    expect(goldens.map(([kind]) => kind)).toEqual(Object.keys(kinds))
  })

  it.each(goldens)('renders a %s type', (kind, html) => {
    expect(aliasTypeHtml(buildReference(kindsProject), kind)).toBe(html)
  })
})
