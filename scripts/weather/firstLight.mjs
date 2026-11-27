// The drive rig evaluates this expression in the page before settling a take.
// Cloud history can converge while warm-up still covers the entire viewport.
;(async () => {
  const deadline = performance.now() + 120_000
  for (;;) {
    const { boot } = ir.status()
    if (boot === 'booted') return boot
    if (performance.now() >= deadline)
      throw new Error(
        `weather capture timed out waiting for first light (${boot})`,
      )
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
})()
