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
