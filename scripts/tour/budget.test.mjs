import { describe, expect, it } from 'vitest'
import { EvaluationBudget } from './budget.mjs'

describe('explicit provider evaluation budget', () => {
  it('reserves the full next round before sending and settles its actual usage', () => {
    const budget = new EvaluationBudget(0.2)
    const first = budget.reserve('gpt-6-astra')
    expect(() => budget.reserve('gpt-6-astra')).toThrow('budget')
    first.settle({ inputTokens: 1000, outputTokens: 100 })
    expect(budget.snapshot()).toMatchObject({
      spentUsd: 0.015,
      reservedUsd: 0,
      rounds: 1,
      uncertainRounds: 0,
    })
    const second = budget.reserve('gpt-6-astra')
    second.settle(null)
    expect(budget.snapshot()).toMatchObject({
      spentUsd: 0.195,
      uncertainRounds: 1,
    })
    expect(() => budget.reserve('gpt-6-astra')).toThrow('budget')
  })
  it('charges a settled ticket once and refuses unsupported models or excessive round counts', () => {
    const budget = new EvaluationBudget(6, 1)
    expect(() => budget.reserve('other-model')).toThrow('model')
    const ticket = budget.reserve('gpt-6-astra')
    ticket.settle({ inputTokens: 1000, outputTokens: 100 })
    ticket.settle({ inputTokens: 1000, outputTokens: 100 })
    expect(budget.snapshot().spentUsd).toBe(0.015)
    expect(() => budget.reserve('gpt-6-astra')).toThrow('round')
  })
})
