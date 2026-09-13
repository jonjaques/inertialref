import { describe, expect, it } from 'vitest'
import {
  admission,
  settleAdmission,
  emptyLedger,
  reserveSpend,
  type SessionBudget,
} from './policy.ts'

describe('tour admission and spend', () => {
  it('reserves across sessions and rejects another tab instead of resetting its quota', () => {
    const first = admission(emptyLedger(), 'alpha', 'one', 'tab-a', 100, 's1')
    expect(first.ok).toBe(true)
    expect(admission(first.ledger, 'alpha', 'two', 'tab-b', 101, 's2').ok).toBe(
      false,
    )
    const repeat = admission(first.ledger, 'alpha', 'one', 'tab-a', 102, 's3')
    expect(repeat.reservation?.sessionId).toBe('s1')
    expect(admission(first.ledger, 'alpha', 'one', 'tab-b', 102, 's3').ok).toBe(
      false,
    )
  })

  it('keeps uncertain closure charged and daily spend after reconnect or restart', () => {
    let ledger = emptyLedger()
    for (let i = 0; i < 5; i++) {
      const opened = admission(
        ledger,
        'alpha',
        `key-${i}`,
        'tab',
        100 + i,
        `s${i}`,
      )
      expect(opened.ok).toBe(true)
      ledger = settleAdmission(opened.ledger, `s${i}`, 2_000_000)
      ledger = JSON.parse(JSON.stringify(ledger))
    }
    expect(admission(ledger, 'alpha', 'six', 'tab', 200, 's6').reason).toBe(
      'daily-budget',
    )
    expect(
      admission(ledger, 'alpha', 'next-day', 'tab', 86_400_001, 's7').ok,
    ).toBe(true)
  })

  it('retains a closed idempotency key and never initializes a provider twice', () => {
    const opened = admission(emptyLedger(), 'alpha', 'one', 'tab', 100, 's1')
    const closed = settleAdmission(opened.ledger, 's1', 30_000)
    const repeat = admission(closed, 'alpha', 'one', 'tab', 200, 's2')
    expect(repeat.ok).toBe(false)
    expect(repeat.reason).toBe('closed')
  })

  it('reserves the maximum before dispatch and never refunds an uncertain call', () => {
    const budget: SessionBudget = {
      limit: 2_000_000,
      spent: 500_000,
      reserved: 0,
      calls: 0,
    }
    const first = reserveSpend(budget, 180_000)
    expect(first?.reserved).toBe(180_000)
    expect(reserveSpend({ ...budget, spent: 1_900_000 }, 180_000)).toBeNull()
    expect(reserveSpend(budget, Number.NaN)).toBeNull()
    expect(reserveSpend(budget, -1)).toBeNull()
  })

  it('enforces a global concurrency ceiling independently of user allowance', () => {
    let ledger = emptyLedger()
    for (let i = 0; i < 4; i++)
      ledger = admission(ledger, `u${i}`, 'one', 'tab', 100, `s${i}`).ledger
    expect(admission(ledger, 'fifth', 'one', 'tab', 100, 's5').reason).toBe(
      'concurrency',
    )
  })
})
