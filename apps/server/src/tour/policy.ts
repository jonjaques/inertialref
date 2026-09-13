/** Amounts are integer millionths of a dollar. Reservations survive uncertain calls. */
export const TOUR_POLICY = {
  sessionMs: 600_000,
  reconnectMs: 30_000,
  finalizeMs: 5_000,
  dailyLimit: 10_000_000,
  sessionLimit: 2_000_000,
  globalConcurrency: 4,
  directorReservation: 180_000,
  speechReservation: 120_000,
  liveReservation: 500_000,
} as const

export interface AdmissionReservation {
  readonly sessionId: string
  readonly user: string
  readonly key: string
  readonly tabId: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly reserved: number
  readonly settled: number | null
}

export interface AdmissionLedger {
  readonly reservations: readonly AdmissionReservation[]
}

export const emptyLedger = (): AdmissionLedger => ({ reservations: [] })

export function admission(
  ledger: AdmissionLedger,
  user: string,
  key: string,
  tabId: string,
  now: number,
  sessionId: string,
) {
  const day = Math.floor(now / 86_400_000)
  const held = ledger.reservations.filter(
    (row) =>
      row.settled === null || Math.floor(row.createdAt / 86_400_000) >= day - 1,
  )
  const repeat = held.find((row) => row.user === user && row.key === key)
  const reject = (reason: string) => ({
    ok: false,
    reason,
    ledger: { reservations: held },
    reservation: null,
  })
  if (repeat) {
    if (repeat.tabId !== tabId) return reject('controlling-tab')
    if (repeat.settled !== null || now >= repeat.expiresAt)
      return reject('closed')
    return {
      ok: true,
      reason: null,
      ledger: { reservations: held },
      reservation: repeat,
    }
  }
  // An expired lease stays reserved until its coordinator confirms cleanup.
  const active = held.filter((row) => row.settled === null)
  if (
    active.some((row) => row.user === user) ||
    active.length >= TOUR_POLICY.globalConcurrency
  )
    return reject('concurrency')
  const daily = held
    .filter(
      (row) =>
        row.user === user && Math.floor(row.createdAt / 86_400_000) === day,
    )
    .reduce((sum, row) => sum + (row.settled ?? row.reserved), 0)
  if (daily + TOUR_POLICY.sessionLimit > TOUR_POLICY.dailyLimit)
    return reject('daily-budget')
  if (held.length >= 256) return reject('admission-capacity')
  const reservation: AdmissionReservation = {
    sessionId,
    user,
    key,
    tabId,
    createdAt: now,
    expiresAt: now + TOUR_POLICY.sessionMs,
    reserved: TOUR_POLICY.sessionLimit,
    settled: null,
  }
  return {
    ok: true,
    reason: null,
    ledger: { reservations: [...held, reservation] },
    reservation,
  }
}

export function settleAdmission(
  ledger: AdmissionLedger,
  sessionId: string,
  cost: number,
): AdmissionLedger {
  return {
    reservations: ledger.reservations.map((row) =>
      row.sessionId === sessionId && row.settled === null
        ? {
            ...row,
            settled:
              Number.isSafeInteger(cost) && cost >= 0
                ? Math.min(cost, row.reserved)
                : row.reserved,
          }
        : row,
    ),
  }
}

export interface SessionBudget {
  readonly limit: number
  readonly spent: number
  readonly reserved: number
  readonly calls: number
}

export function reserveSpend(
  budget: SessionBudget,
  amount: number,
): SessionBudget | null {
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    budget.spent + budget.reserved + amount > budget.limit ||
    budget.calls >= 24
  )
    return null
  return {
    ...budget,
    reserved: budget.reserved + amount,
    calls: budget.calls + 1,
  }
}

export function commitSpend(
  budget: SessionBudget,
  reserved: number,
  actual = reserved,
): SessionBudget {
  const charged =
    Number.isSafeInteger(actual) && actual >= 0
      ? Math.min(actual, reserved)
      : reserved
  return {
    ...budget,
    reserved: Math.max(0, budget.reserved - reserved),
    spent: budget.spent + charged,
  }
}
