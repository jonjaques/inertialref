import type { AuthorityStatus } from '@inertialref/net'
import { Row } from './Row.tsx'
import { Section } from './Section.tsx'

/*
 * Who owns the simulation this client is part of.
 *
 * Separate from `network` because they are different questions with different
 * answers: you can be online and alone, which is the normal case, and the
 * costly one this design goes out of its way to avoid paying for (H-6).
 *
 * `partition` appears here *and* on the player, deliberately. The player row is
 * the overlay's own derivation from the frame chain; this one is what the
 * authority believes. They agree by construction today, and the whole reason
 * `partitionForFrames` exists is that they once agreed only by coincidence — so
 * showing both is what makes a future disagreement visible instead of subtle.
 */
export function AuthoritySection({
  authority,
}: {
  authority: AuthorityStatus | null
}) {
  if (authority === null)
    return (
      <Section id="tel.authority" title="authority" trailing="none">
        <div className="text-slate-400">no authority joined</div>
      </Section>
    )

  const { kind, state, partition, peers, streaming, submitted, detail } =
    authority
  return (
    <Section id="tel.authority" title="authority" trailing={kind}>
      <Row label="owner" value={`${kind} · ${state}`} />
      <Row label="partition" value={partition ?? '—'} />
      <Row
        label="peers"
        value={
          peers === 0 ? 'alone' : `${peers} other${peers === 1 ? '' : 's'}`
        }
      />
      <Row
        label="streaming"
        value={streaming ? 'entities' : 'nothing to send'}
      />
      <Row label="intent" value={`${submitted} submitted`} />
      {detail !== null && <Row label="detail" value={detail} wrap />}
      <div className="mt-1 text-slate-400">
        alone is not degraded — it is the mode the universe is designed around
      </div>
    </Section>
  )
}
