import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  decodeGuideCall,
  GUIDE_CLIENT_EVENTS,
  GUIDE_LIMITS,
  GUIDE_TOOL_NAMES,
  GUIDE_TOOLS,
} from './guideTools.ts'

describe('the guide tool inventory', () => {
  it('declares every tool as a strict function with every argument required', () => {
    expect(GUIDE_TOOLS.map((tool) => tool.name)).toEqual([...GUIDE_TOOL_NAMES])
    for (const tool of GUIDE_TOOLS) {
      expect(tool.strict).toBe(true)
      expect(tool.parameters.additionalProperties).toBe(false)
      expect(tool.parameters.required).toEqual(
        Object.keys(tool.parameters.properties),
      )
    }
  })
  it('never lets the browser change the session', () => {
    expect(GUIDE_CLIENT_EVENTS).not.toContain('session.update')
    expect(GUIDE_CLIENT_EVENTS).toContain('session.close')
  })
  it('decodes a move, a declaration, and a search', () => {
    expect(
      decodeGuideCall(
        'go_to',
        '{"subject":"Saturn","framing":"preset:the-rings","motion":null}',
      ),
    ).toEqual({
      ok: true,
      value: {
        name: 'go_to',
        subject: 'Saturn',
        framing: 'preset:the-rings',
        motion: null,
      },
    })
    expect(
      decodeGuideCall('linger', '{"seconds":10,"reason":"the rings"}').ok,
    ).toBe(true)
    expect(decodeGuideCall('describe_view', '').ok).toBe(true)
    expect(
      decodeGuideCall(
        'find_worlds',
        JSON.stringify({
          query: {
            kinds: ['rocky'],
            star_classes: [],
            atmosphere: true,
            sea: null,
            rings: null,
            habitable: null,
            landable: null,
            moons: null,
            min_radius: null,
            max_radius: null,
          },
          radius_light_years: 4,
          limit: 8,
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: { query: { kinds: ['rocky'], atmosphere: true, minRadius: null } },
    })
  })
  it('rejects extra fields, missing fields, and values outside their bounds', () => {
    expect(
      decodeGuideCall(
        'go_to',
        '{"subject":"Saturn","framing":null,"motion":null,"address":"s:SOL/b:5"}',
      ).ok,
    ).toBe(false)
    expect(decodeGuideCall('go_to', '{"subject":"Saturn"}').ok).toBe(false)
    expect(
      decodeGuideCall(
        'linger',
        `{"seconds":${GUIDE_LIMITS.lingerSeconds.max + 1},"reason":"x"}`,
      ).ok,
    ).toBe(false)
    expect(
      decodeGuideCall('set_time', '{"mode":"set","instant":null,"rate":null}')
        .ok,
    ).toBe(false)
    expect(
      decodeGuideCall(
        'set_time',
        '{"mode":"set","instant":"not a date","rate":null}',
      ).ok,
    ).toBe(false)
    expect(
      decodeGuideCall(
        'set_time',
        '{"mode":"set","instant":"2026-09-13T21:04:10Z","rate":null}',
      ).ok,
    ).toBe(true)
    expect(decodeGuideCall('go_to', 'not json').ok).toBe(false)
  })
  it('never accepts an unknown tool name', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        if ((GUIDE_TOOL_NAMES as readonly string[]).includes(name)) return
        expect(decodeGuideCall(name, '{}').ok).toBe(false)
      }),
    )
  })
  it('never accepts an argument the schema does not name', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...GUIDE_TOOL_NAMES),
        fc.string({ minLength: 1 }).filter((key) => !/^[a-z_]+$/.test(key)),
        (name, key) => {
          expect(decodeGuideCall(name, JSON.stringify({ [key]: 1 })).ok).toBe(
            false,
          )
        },
      ),
    )
  })
})
