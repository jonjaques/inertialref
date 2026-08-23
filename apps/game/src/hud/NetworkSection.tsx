import { BUILD_ID } from '../build.ts'
import { CLIENT_VERSIONS, type Connection } from '../net/health.ts'
import { Action } from './Action.tsx'
import { CONNECTION_LABEL, connectionTone, sinceText } from './connection.ts'
import { Row } from './Row.tsx'
import { Section } from './Section.tsx'

/*
 * The network readout.
 *
 * Six rows that answer one question each, and the two that matter most are the
 * last pair: which bundle this browser is running, and which deployment
 * answered. "The fix is live but I still see the bug" is otherwise a guess, and
 * it is a guess a service worker makes easy to get wrong.
 *
 * `generation` is here rather than under `simulation` because it is the thing
 * the handshake actually compares. Two clients agreeing on a protocol version
 * and disagreeing on a terrain version derive different mountains, and this is
 * the row where that becomes visible instead of mysterious.
 */
export function NetworkSection({
  connection,
  onCheck,
}: {
  connection: Connection
  onCheck: () => void
}) {
  const { state, detail, health, checkedAt, failures } = connection
  const generation = Object.entries(health?.generation ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, version]) => `${name} ${version}`)
    .join(' · ')

  return (
    <Section
      id="tel.network"
      title="Network"
      trailing={CONNECTION_LABEL[state]}
    >
      <div className="flex justify-between gap-3">
        <span className="shrink-0 text-slate-400">state</span>
        <span className={`truncate text-right ${connectionTone(state)}`}>
          {CONNECTION_LABEL[state]}
          {health !== null && health.colo !== '' ? ` · ${health.colo}` : ''}
          {failures > 1 ? ` · ${failures} failed checks` : ''}
        </span>
      </div>
      <Row label="Detail" value={detail ?? '—'} wrap />
      <Row
        label="Protocol"
        value={
          health === null
            ? `${CLIENT_VERSIONS.protocol} here, server unknown`
            : `${health.protocol} server · ${CLIENT_VERSIONS.protocol} here`
        }
      />
      <Row label="Generation" value={generation || '—'} wrap />
      <Row label="Client Build" value={BUILD_ID} />
      <Row label="Server Build" value={health?.revision ?? '—'} />
      <Row label="Checked" value={sinceText(checkedAt)} />
      <div className="mt-1 flex items-center gap-1">
        <Action
          label="Check Now"
          title="Probe /api/health immediately"
          onClick={onCheck}
        />
        {/* Said plainly, because the color of a dot is not a promise. */}
        <span className="text-slate-400">
          the game does not need any of this
        </span>
      </div>
    </Section>
  )
}
