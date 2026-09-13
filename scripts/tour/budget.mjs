/** Evaluation-only standard rates, checked against model cards on 2026-09-13. */
export const EVALUATION_PRICES = {
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5.6-terra': { input: 2, output: 12 },
}

export class EvaluationBudget {
  #limit
  #maxRounds
  #spent = 0
  #reserved = 0
  #rounds = 0
  #uncertainRounds = 0

  constructor(maxUsd, maxRounds = 360) {
    if (
      !Number.isFinite(maxUsd) ||
      maxUsd <= 0 ||
      maxUsd > 100 ||
      !Number.isInteger(maxRounds) ||
      maxRounds < 1 ||
      maxRounds > 360
    )
      throw new Error('Invalid evaluation budget.')
    this.#limit = Math.floor(maxUsd * 1e6)
    this.#maxRounds = maxRounds
  }

  reserve(model) {
    const price = EVALUATION_PRICES[model]
    if (!price) throw new Error('Unsupported evaluation model.')
    if (this.#rounds >= this.#maxRounds)
      throw new Error('Evaluation round limit reached.')
    const reserved = 8000 * price.input + 2000 * price.output
    if (this.#spent + this.#reserved + reserved > this.#limit)
      throw new Error('Evaluation budget reached.')
    this.#reserved += reserved
    this.#rounds++
    let settled = false
    return {
      settle: (usage) => {
        if (settled) return
        settled = true
        this.#reserved -= reserved
        if (
          usage &&
          Number.isSafeInteger(usage.inputTokens) &&
          Number.isSafeInteger(usage.outputTokens) &&
          usage.inputTokens >= 0 &&
          usage.outputTokens >= 0
        )
          this.#spent +=
            usage.inputTokens * price.input + usage.outputTokens * price.output
        else {
          this.#spent += reserved
          this.#uncertainRounds++
        }
      },
    }
  }

  snapshot() {
    return {
      limitUsd: this.#limit / 1e6,
      spentUsd: this.#spent / 1e6,
      reservedUsd: this.#reserved / 1e6,
      rounds: this.#rounds,
      uncertainRounds: this.#uncertainRounds,
      rateDate: '2026-09-13',
      rateSource: 'https://developers.openai.com/api/docs/models',
      prices: EVALUATION_PRICES,
    }
  }
}
