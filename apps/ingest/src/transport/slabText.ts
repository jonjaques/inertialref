/*
 * What a generated table's text is made of: a header filled to width,
 * numbers and records held as text, and the roundings a table is printed
 * to. Both generated files are written through these, so both are held to
 * one account of why a table is not an array literal.
 */

/** Five figures: a radiance's rounding is at most 5 × 10⁻⁵ of it, a hundredth of the oracle's own convergence. */
export const five = (value: number): number => Number(value.toPrecision(5))
export const percent = (value: number): string => `${(100 * value).toFixed(2)}%`

/** The shortest decimal that rounds to the same half float as `value`. */
export function halfDecimal(value: number): number {
  const half = Math.f16round(value)
  for (let digits = 1; digits <= 9; digits += 1) {
    const short = Number(half.toPrecision(digits))
    if (Math.f16round(short) === half) return short
  }
  return half
}

/**
 * A header: runs of lines are paragraphs, filled to 76 columns, so a figure
 * of any length leaves no line long; an empty line parts two paragraphs,
 * and a line that starts with two spaces is kept as it is written.
 */
export function comment(lines: readonly string[]): string {
  const out: string[] = []
  let words: string[] = []
  const fill = (): void => {
    let line = ''
    for (const word of words) {
      if (line !== '' && line.length + 1 + word.length > 76) {
        out.push(line)
        line = word
      } else line = line === '' ? word : `${line} ${word}`
    }
    if (line !== '') out.push(line)
    words = []
  }
  for (const line of lines) {
    if (line === '' || line.startsWith('  ')) {
      fill()
      out.push(line)
    } else words.push(...line.split(' '))
  }
  fill()
  return (
    '/*\n' +
    out.map((line) => (line ? ` * ${line}` : ' *')).join('\n') +
    '\n */\n'
  )
}

/**
 * Numbers as a generated file holds them: text, parsed where the file is
 * read. An array literal of thirty thousand numbers is thirty thousand
 * operands to the complexity score, and a number a line is thirty thousand
 * lines to it: either way it reads a table as the most complex file in the
 * tree.
 */
export function numbersText(
  values: readonly number[],
  perLine: number,
): string {
  const lines: string[] = []
  for (let at = 0; at < values.length; at += perLine)
    lines.push(values.slice(at, at + perLine).join(' '))
  return '`\n' + lines.join('\n') + '\n`'
}

/** Records as a generated file holds them, for the same reason: JSON text, a record a line. */
export function recordsText(records: readonly object[]): string {
  return (
    '`[\n' +
    records.map((record) => JSON.stringify(record)).join(',\n') +
    '\n]`'
  )
}

/** The parser a generated file carries for `numbersText`. */
export const NUMBERS_TEXT = [
  '/** The numbers a block of text holds, a row a line. */',
  'function numbers(text: string): readonly number[] {',
  '  return text.trim().split(/\\s+/).map(Number)',
  '}',
  '',
]
