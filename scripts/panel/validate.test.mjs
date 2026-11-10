import { homedir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cellsOf, validateReview } from './validate.mjs'

/*
 * One packet of two scenes: E1 (ranked, five dimensions) and G3 (Shadow
 * when present), and a guard pair. The key puts the low anchor and the
 * photograph in E1 and the duplicate in G3.
 */
const images = (scene, letters, crops = ['crop']) =>
  letters.map((letter) => ({
    letter,
    full: `${scene}/${letter}.png`,
    crops: crops.map((crop) => `${scene}/${letter}.${crop}.png`),
  }))
const packet = {
  scenes: [
    {
      scene: 'e1',
      tag: 'e1',
      kind: 'still',
      images: images('e1', ['A', 'B', 'C', 'D']),
      references: [{ file: 'e1/references/1.png' }],
    },
    {
      scene: 'g3',
      tag: 'g3',
      kind: 'still',
      images: images('g3', ['A', 'B']),
      references: [],
    },
    {
      scene: 'guard-x',
      tag: null,
      kind: 'guard',
      images: images('guard-x', ['A', 'B'], []),
      references: [],
    },
  ],
}
const key = {
  scenes: {
    e1: {
      A: { arm: 'candidate' },
      B: { arm: 'deck' },
      C: { arm: 'low-anchor' },
      D: { arm: 'photograph' },
    },
    g3: { A: { arm: 'candidate' }, B: { arm: 'duplicate', of: 'A' } },
    'guard-x': { A: { arm: 'new' }, B: { arm: 'old' } },
  },
}
const row = (value, dimensions) =>
  Object.fromEntries([...dimensions, 'overall'].map((d) => [d, value]))
const FIVE = ['form', 'light', 'shadow', 'integration', 'artifacts']
const review = () => ({
  scenes: {
    e1: {
      scores: {
        A: row(8, FIVE),
        B: row(5, FIVE),
        C: row(4, FIVE),
        D: row(9, FIVE),
      },
      rankings: {
        form: ['D', 'A', 'B', 'C'],
        light: ['D', 'A', 'B', 'C'],
        shadow: ['D', 'A', 'B', 'C'],
      },
      artifacts: [
        {
          arm: 'A',
          class: 'grain',
          region: 'top-left+middle-left',
          full: false,
        },
      ],
    },
    g3: {
      scores: {
        A: { ...row(7, FIVE), shadow: null },
        B: { ...row(7, FIVE), shadow: null },
      },
    },
    'guard-x': {
      scores: {
        A: row(8, ['integration', 'artifacts']),
        B: row(8, ['integration', 'artifacts']),
      },
      worse: { integration: 'A', artifacts: 'B' },
    },
  },
  observations: [
    { image: 'e1/A.png', text: 'the brightest cell is top right' },
    { image: 'e1/A.crop.png', text: 'two shadows overlap' },
    { image: 'e1/references/1.png', text: 'a river crosses it' },
  ],
  opened: ['brief.md', 'e1/A.png', '~/.claude/skills/unslop/SKILL.md'],
})
const dir = '/tmp/packet'
const check = (answer) => validateReview(answer, { packet, key, dir })

describe('validate.mjs', () => {
  it('accepts a well-formed answer, Shadow left null where it is scored when present', () => {
    expect(check(review())).toEqual({
      malformed: [],
      unblinded: [],
      controls: [],
      valid: true,
    })
  })

  it('refuses a score out of range, a fraction, a missing or a foreign dimension', () => {
    const answer = review()
    answer.scenes.e1.scores.A.form = 11
    answer.scenes.e1.scores.B.light = 7.5
    delete answer.scenes.e1.scores.C.shadow
    answer.scenes.e1.scores.D.glow = 4
    answer.scenes.e1.scores.A.shadow = null // Shadow is not optional on E1
    const result = check(answer)
    expect(result.valid).toBe(false)
    expect(result.malformed).toEqual([
      'e1/A: form must be an integer 0–10',
      'e1/A: shadow must be an integer 0–10',
      'e1/B: light must be an integer 0–10',
      'e1/C: shadow must be an integer 0–10',
      'e1/D: glow is not scored on this picture',
    ])
  })

  it('refuses a tie or a gap in a forced ranking', () => {
    const answer = review()
    answer.scenes.e1.rankings.form = ['D', 'A', 'A', 'C']
    delete answer.scenes.e1.rankings.shadow
    expect(check(answer).malformed).toEqual([
      'e1: form must rank every image once, with no tie',
      'e1: shadow must rank every image once, with no tie',
    ])
  })

  it('refuses a class or a region outside the vocabulary', () => {
    const answer = review()
    answer.scenes.e1.artifacts = [
      { arm: 'A', class: 'moire', region: 'top-left', full: true },
      { arm: 'A', class: 'seam', region: 'top-left+bottom-right', full: true },
      { arm: 'A', class: 'seam', region: 'terminator', full: false },
      { arm: 'Z', class: 'halo', region: 'crop', full: 'yes' },
    ]
    expect(check(answer).malformed).toEqual([
      'e1: artifact 1: class moire is not one of the nine',
      'e1: artifact 2: region top-left+bottom-right',
      'e1: artifact 3: region terminator',
      'e1: artifact 4 names no image of the scene',
      'e1: artifact 4: full must be true or false',
    ])
  })

  it('reads a region as one cell, two that share an edge, or a crop by name', () => {
    expect(cellsOf('middle-center')).toEqual(['middle-center'])
    expect(cellsOf('top-right+middle-right')).toEqual([
      'top-right',
      'middle-right',
    ])
    expect(cellsOf('top-left+middle-center')).toBeNull()
    expect(cellsOf('terminator', ['crop', 'terminator'])).toEqual([
      'terminator',
    ])
  })

  it('refuses observations that are not three, or name no packet image', () => {
    const answer = review()
    answer.observations[2].image = 'e1/Z.png'
    expect(check(answer).malformed).toEqual([
      'observation 3 must name a packet image and say something',
    ])
    answer.observations.pop()
    expect(check(answer).malformed).toEqual([
      'three observations, no more and no fewer',
    ])
  })

  it('refuses a guard answer that does not say which plate is worse', () => {
    const answer = review()
    delete answer.scenes['guard-x'].worse.artifacts
    expect(check(answer).malformed).toEqual([
      'guard-x: worse.artifacts must name one image',
    ])
  })

  it('sets aside a seat that opened a file outside its packet and its harness’s skills', () => {
    const answer = review()
    answer.opened.push('../keys/seat-1.json', path.join(homedir(), 'notes.md'))
    expect(check(answer).unblinded).toEqual([
      'opened ../keys/seat-1.json, outside the packet',
      `opened ${path.join(homedir(), 'notes.md')}, outside the packet`,
    ])
  })

  it('discards a seat for each failed control (rubric §3.3)', () => {
    const answer = review()
    answer.scenes.g3.scores.B.form = 5 // the duplicate two from its twin
    answer.scenes.e1.scores.C.form = 6 // the low anchor at 6
    answer.scenes.e1.scores.D.light = 6 // the photograph under 7
    expect(check(answer).controls).toEqual([
      'the low anchor e1/C scores 6 on Form',
      'the withheld photograph e1/D scores 9 on Form and 6 on Light',
      'the duplicate pair g3/B and A is more than a point apart on form',
    ])
  })

  it('reads a duplicate scored on one copy and left null on the other as apart', () => {
    const answer = review()
    answer.scenes.g3.scores.B.shadow = 7
    expect(check(answer).controls).toEqual([
      'the duplicate pair g3/B and A is more than a point apart on shadow',
    ])
  })
})
