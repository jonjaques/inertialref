import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  NUMBERS_TEXT,
  comment,
  five,
  halfDecimal,
  numbersText,
  percent,
  recordsText,
} from './slabText.ts'

describe('a half float’s decimal', () => {
  it('is the shortest that rounds to the same half float', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -60000, max: 60000, noNaN: true }),
        (value) => {
          const short = halfDecimal(value)
          // `===`, not `Object.is`: a zero's sign is nothing a table holds.
          expect(Math.f16round(short) === Math.f16round(value)).toBe(true)
          expect(String(short).length).toBeLessThanOrEqual(
            String(Math.f16round(value)).length,
          )
        },
      ),
    )
    expect(halfDecimal(0)).toBe(0)
    expect(halfDecimal(0.1)).toBe(0.1)
  })
})

describe('a generated file’s text', () => {
  it('fills a header’s paragraphs to 76 columns and keeps an indented line as written', () => {
    const text = comment([
      'A paragraph of a figure that may be of any length,',
      `${'word '.repeat(30)}end.`,
      '',
      '  an equation   kept   as it is',
      'After it.',
    ])
    const lines = text.split('\n')
    expect(lines[0]).toBe('/*')
    expect(lines.at(-2)).toBe(' */')
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(79)
    expect(lines).toContain(' *')
    expect(lines).toContain(' *   an equation   kept   as it is')
    expect(lines).toContain(' * After it.')
    // The two lines of the first paragraph are one run of words.
    expect(lines[1]!.endsWith('length, word word word word word')).toBe(true)
  })

  it('holds numbers as text a parser of its own reads back, a row a line', () => {
    const values = [1, -0.5, 2e-7, 65504, 0, 3.25, 7]
    const text = numbersText(values, 3)
    expect(text.split('\n')).toEqual([
      '`',
      '1 -0.5 2e-7',
      '65504 0 3.25',
      '7',
      '`',
    ])
    // The parser the generated file carries, as it is written there.
    const body = NUMBERS_TEXT.join('\n').replace(
      /function numbers\(text: string\): readonly number\[\]/,
      'return function numbers(text)',
    )
    const numbers = new Function(body)() as (text: string) => number[]
    expect(numbers(text.slice(1, -1))).toEqual(values)
  })

  it('holds records as JSON text, a record a line', () => {
    const records = [{ depth: 5, side: 'reflected' }, { depth: 7 }]
    const text = recordsText(records)
    expect(text.split('\n')).toHaveLength(4)
    expect(JSON.parse(text.slice(1, -1))).toEqual(records)
  })

  it('prints a radiance to five figures and an error to a hundredth of a percent', () => {
    expect(five(0.123456789)).toBe(0.12346)
    expect(five(123456.789)).toBe(123460)
    expect(percent(0.056449)).toBe('5.64%')
  })
})
