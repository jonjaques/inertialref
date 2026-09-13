/** Local clarification is a decision but consumes no provider request. */
export function evaluationCounts(records) {
  const rounds = records.flatMap((record) => record.providerRounds ?? [])
  return {
    validDecisions: records.filter((record) => record.decision !== null).length,
    localDecisions: records.filter((record) => record.decision?.model === null)
      .length,
    providerCalls: rounds.length,
    providerHttpSuccesses: rounds.filter((round) => round.status === 200)
      .length,
  }
}
