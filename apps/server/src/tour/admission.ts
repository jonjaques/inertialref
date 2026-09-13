import { DurableObject } from 'cloudflare:workers'
import {
  admission,
  emptyLedger,
  settleAdmission,
  type AdmissionLedger,
} from './policy.ts'

/** This object coordinates the shared alpha allowance, not conversation traffic. */
export class TourAdmission extends DurableObject<Env> {
  async availability() {
    const held = await this.ctx.storage.get<{
      checkedAt: number
      text: boolean
      live: boolean
      controlledSpeech: boolean
    }>('availability')
    if (held && Date.now() - held.checkedAt < 600_000) return held
    const models = ['gpt-6-astra', 'gpt-live-1', 'gpt-4o-mini-tts']
    const found = await Promise.all(
      models.map(async (model) => {
        try {
          const response = await fetch(
            `https://api.openai.com/v1/models/${model}`,
            {
              headers: { authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
              signal: AbortSignal.timeout(5000),
            },
          )
          await response.body?.cancel()
          return response.ok
        } catch {
          return false
        }
      }),
    )
    const result = {
      checkedAt: Date.now(),
      text: found[0] === true,
      live: found[1] === true,
      controlledSpeech: found[2] === true,
    }
    await this.ctx.storage.put('availability', result)
    return result
  }
  async reserve(user: string, key: string, tabId: string) {
    const now = Date.now()
    return this.ctx.storage.transaction(async (transaction) => {
      const ledger =
        (await transaction.get<AdmissionLedger>('ledger')) ?? emptyLedger()
      const result = admission(
        ledger,
        user,
        key,
        tabId,
        now,
        crypto.randomUUID(),
      )
      await transaction.put('ledger', result.ledger)
      const alarm = await transaction.getAlarm()
      if (!alarm || alarm > now + 30_000)
        await transaction.setAlarm(now + 30_000)
      return result.ok && result.reservation
        ? { ok: true as const, reservation: result.reservation }
        : { ok: false as const, reason: result.reason ?? 'unavailable' }
    })
  }

  async settle(sessionId: string, cost: number): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const ledger =
        (await transaction.get<AdmissionLedger>('ledger')) ?? emptyLedger()
      await transaction.put('ledger', settleAdmission(ledger, sessionId, cost))
    })
  }

  async loginAttempt(key: string): Promise<boolean> {
    const now = Date.now()
    return this.ctx.storage.transaction(async (transaction) => {
      const rows =
        (await transaction.get<
          Record<string, { count: number; until: number }>
        >('attempts')) ?? {}
      for (const [id, row] of Object.entries(rows))
        if (row.until <= now) delete rows[id]
      const own = rows[key] ?? { count: 0, until: now + 900_000 }
      const global = rows.global ?? { count: 0, until: now + 60_000 }
      if (
        own.count >= 8 ||
        global.count >= 80 ||
        Object.keys(rows).length > 1024
      )
        return false
      rows[key] = { ...own, count: own.count + 1 }
      rows.global = { ...global, count: global.count + 1 }
      await transaction.put('attempts', rows)
      return true
    })
  }

  async report(user: string) {
    const ledger =
      (await this.ctx.storage.get<AdmissionLedger>('ledger')) ?? emptyLedger()
    const day = Math.floor(Date.now() / 86_400_000)
    const rows = ledger.reservations.filter(
      (row) =>
        row.user === user && Math.floor(row.createdAt / 86_400_000) === day,
    )
    return {
      sessions: rows.length,
      active: rows.filter((row) => row.settled === null).length,
      reservedMicroDollars: rows
        .filter((row) => row.settled === null)
        .reduce((sum, row) => sum + row.reserved, 0),
      chargedMicroDollars: rows.reduce(
        (sum, row) => sum + (row.settled ?? 0),
        0,
      ),
    }
  }

  override async alarm(): Promise<void> {
    const ledger =
      (await this.ctx.storage.get<AdmissionLedger>('ledger')) ?? emptyLedger()
    const active = ledger.reservations.filter((row) => row.settled === null)
    for (const row of active) {
      if (row.expiresAt <= Date.now()) {
        await this.env.TOUR_SESSIONS.getByName(row.sessionId).expire()
        await this.settle(row.sessionId, row.reserved)
      }
    }
    if (active.length) await this.ctx.storage.setAlarm(Date.now() + 30_000)
  }
}
