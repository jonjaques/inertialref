import { Section } from '../hud/Section.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import {
  TELEMETRY_REPLAY,
  TELEMETRY_TRANSCRIPTS,
  TELEMETRY_USAGE,
  usePersistentState,
} from '../state/preferences.ts'
import { useHydrated } from '../state/hydration.ts'
import { hasOptedOut } from '../telemetry/consent.ts'

/*
 * What this browser reports, and the three switches that decide it.
 *
 * Stated where the visitor's other data choices are, in the words of what
 * each tier sends, because a switch labeled "analytics" tells nobody what
 * leaves their machine. The retention figures are PostHog's for the plan the
 * project is on; `docs/adr/0061-telemetry-is-posthog.md` names them.
 *
 * Global Privacy Control and Do Not Track override every switch here
 * (`telemetry/consent.ts`), and the page says so rather than drawing switches
 * that do nothing.
 */
export function ReportingSection() {
  const [usage, setUsage] = usePersistentState(TELEMETRY_USAGE)
  const [transcripts, setTranscripts] = usePersistentState(
    TELEMETRY_TRANSCRIPTS,
  )
  const [replay, setReplay] = usePersistentState(TELEMETRY_REPLAY)
  // After hydration: the prerendered page cannot know the browser's signal,
  // and answering differently on the first client render is a mismatch.
  const blocked = useHydrated() && hasOptedOut()

  return (
    <Section id="settings.data.reporting" title="What this browser reports">
      <p className="type-ui pb-1 text-pretty text-slate-400">
        {blocked
          ? 'Your browser asks sites not to track it, so this one reports nothing, whatever these say.'
          : 'Reports go to PostHog, which keeps events for a year, recordings and transcripts for 30 days, and never your address.'}
      </p>
      <SwitchRow
        divided
        label="Usage and crash reports"
        detail="Pages, modes, timings, errors and which GPU drew them. Never what you type or where you look."
        on={usage}
        changed={usage !== TELEMETRY_USAGE.initial}
        disabled={blocked}
        onChange={setUsage}
      />
      <SwitchRow
        divided
        label="Guide transcripts"
        detail="What you and the guide said on a tour, to improve the guide."
        on={transcripts}
        changed={transcripts !== TELEMETRY_TRANSCRIPTS.initial}
        disabled={blocked || !usage}
        onChange={setTranscripts}
      />
      <SwitchRow
        divided
        label="Session recording"
        detail="A replay of the interface — panels and clicks, with typing masked. The sky is never recorded."
        on={replay}
        changed={replay !== TELEMETRY_REPLAY.initial}
        disabled={blocked || !usage}
        onChange={setReplay}
      />
    </Section>
  )
}
