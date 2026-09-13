import { describe, expect, it } from 'vitest'
import { evaluationCounts } from './report.mjs'

describe('tour evaluation denominators', () => {
  it('counts local handling separately from successful provider responses', () => {
    const records = [
      { decision: { model: null }, providerRounds: [] },
      { decision: { model: 'gpt-6-astra' }, providerRounds: [{ status: 200 }] },
      { decision: null, providerRounds: [{ status: null }] },
    ]
    expect(evaluationCounts(records)).toEqual({
      validDecisions: 2,
      localDecisions: 1,
      providerCalls: 2,
      providerHttpSuccesses: 1,
    })
  })
})
