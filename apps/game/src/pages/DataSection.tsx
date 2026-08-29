import { useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Action } from '../hud/Action.tsx'
import {
  exportPreferences,
  type ImportPlan,
  importPreferences,
  planImport,
  PREFERENCE_GROUPS,
  REGISTRY,
  resetPreferences,
} from '../state/preferences.ts'

/*
 * Every setting this build keeps, and the two things you can do with the lot.
 *
 * A dozen preferences were guarded on the way in and none of them could be
 * listed, so nothing could export them: a layout somebody arranged lived on one
 * browser profile, and a second machine started from the defaults. The registry
 * is the census that makes both of these possible, and this page is what it is
 * for.
 *
 * A file rather than an account, and that is not a placeholder. Preferences are
 * not part of the universe — `docs/concepts/persistence.md` is explicit that a
 * save stores references and mutations, not where somebody put a panel — so
 * they have no business in a save, and syncing them needs an account this build
 * does not require anybody to have. A JSON file is the offline-first answer and
 * it works in the case that matters, which is moving to a second machine.
 */

/** What the downloaded file is called. Dated, because people keep several. */
const filename = (stamp: string): string =>
  `inertialref-settings-${stamp.slice(0, 10)}.json`

export function DataSection() {
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  /** The parsed file, held between the preview and the apply. */
  const pending = useRef<unknown>(null)
  const [done, setDone] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const save = (): void => {
    /*
     * `new Date()` here and nowhere near the simulation.
     *
     * The determinism rule is about canonical code — generation from seeds,
     * simulation from the tick — and the one wall-clock call it allows is
     * `clock.advance`. This is a filename and a line in a file a person reads,
     * which is exactly the case `simulationTime.ts` makes for `Intl`: a
     * timestamp is a property of whoever is looking.
     */
    const stamp = new Date().toISOString()
    const file = exportPreferences(stamp)
    const blob = new Blob([JSON.stringify(file, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename(stamp)
    link.click()
    /*
     * Revoked on the next task, not this one.
     *
     * `click()` on a detached anchor only *queues* the download, and WebKit and
     * Gecko resolve the blob URL asynchronously — revoking in the same task
     * leaves a failed or empty file while this function goes on to report "N
     * settings saved". A blob URL left alive forever would hold the whole file
     * in memory for the session, which is what the timeout is for.
     */
    setTimeout(() => URL.revokeObjectURL(url), 0)
    setDone(`${Object.keys(file.preferences).length} settings saved`)
  }

  const preview = async (file: File): Promise<void> => {
    setDone(null)
    try {
      const parsed: unknown = JSON.parse(await file.text())
      pending.current = parsed
      setPlan(planImport(parsed))
    } catch {
      pending.current = null
      setPlan({ entries: [], applied: 0, dropped: 0 })
    }
  }

  const apply = (): void => {
    const applied = importPreferences(pending.current)
    pending.current = null
    setPlan(null)
    // The panels on screen already show it: `usePersistentState` subscribes,
    // so an import reaches every mounted hook without a reload — which in this
    // app would rebuild the renderer and lose the camera.
    setDone(`${applied.applied} settings applied, live`)
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-pretty text-slate-400">
        Settings live in this browser and go nowhere else. A file is how they
        reach a second machine.
      </p>

      <div className="flex flex-wrap items-center gap-1">
        <Action
          label="Export"
          tone="primary"
          title="Download every setting you have changed, as JSON"
          onClick={save}
        />
        {/* The ring is drawn by `focus-within`, not `FOCUS_RING`.
            A `<label>` never takes focus, so `focus-visible:` on it can never
            match — the only focusable node here is the `sr-only` input, which
            is a clipped pixel. Without this the Import control is the one thing
            on the page a keyboard user cannot see themselves standing on. */}
        <label className="type-ui inline-flex h-7 cursor-pointer items-center rounded border border-slate-700 bg-slate-800/60 px-2 text-slate-300 transition-colors hover:border-sky-500/60 hover:text-sky-200 focus-within:outline focus-within:outline-1 focus-within:outline-sky-400">
          Import
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0]
              // The value is cleared so choosing the same file twice fires
              // again — a `change` that does not change is no event at all, and
              // "import, look at the preview, cancel, import again" is the
              // ordinary way somebody uses this.
              event.target.value = ''
              if (file !== undefined) void preview(file)
            }}
          />
        </label>
        {done !== null && (
          <span aria-live="polite" className="text-sky-300/80">
            {done}
          </span>
        )}
      </div>

      {plan !== null && (
        <div className="flex flex-col gap-2 rounded border border-slate-800 bg-slate-900/40 p-2">
          <h3 className="type-label text-sky-400/80">
            {plan.entries.length === 0
              ? 'Not a settings file'
              : `${plan.applied} to apply, ${plan.dropped} dropped`}
          </h3>
          {/*
           * The preview, before anything changes. A file from another build
           * carries keys this one has never heard of and values it will not
           * believe, and the honest thing is to say which — "2 dropped" with no
           * list is a dialog nobody can act on.
           */}
          {plan.entries.length > 0 && (
            <dl className="grid max-h-48 grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 overflow-y-auto">
              {plan.entries.map((entry) => (
                <div
                  key={entry.key}
                  className="col-span-2 grid grid-cols-subgrid"
                >
                  <dt className="truncate text-slate-400" title={entry.key}>
                    {entry.what}
                  </dt>
                  <dd
                    className={
                      entry.applied ? 'text-sky-300/80' : 'text-amber-400/90'
                    }
                  >
                    {entry.applied ? 'apply' : (entry.reason ?? 'dropped')}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div className="flex flex-wrap gap-1">
            <Action
              label="Apply"
              tone="primary"
              disabled={plan.applied === 0}
              title="Write these settings, live — nothing reloads"
              onClick={apply}
            />
            <Action
              label="Cancel"
              title="Leave everything as it is"
              onClick={() => {
                pending.current = null
                setPlan(null)
              }}
            />
          </div>
        </div>
      )}

      <div className="border-t border-slate-800 pt-3">
        <h3 className="type-label mb-1 flex items-center gap-1.5 text-amber-400/90">
          <AlertTriangle aria-hidden className="size-3" />
          Reset
        </h3>
        <p className="mb-1.5 text-pretty text-slate-400">
          Every setting back to its default: the lens, the layers, the key
          bindings and where the panels sit. Saved games are stored separately
          and are untouched.
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {/* Confirmed in place rather than through a dialog, because this page
              is already inside one and a dialog over a dialog is a scrim over a
              scrim. The destructive label only appears once it has been asked
              for, so the resting state cannot be pressed by accident. */}
          {confirming ? (
            <>
              <Action
                label="Yes, reset everything"
                tone="primary"
                title="Forget every setting this browser holds"
                onClick={() => {
                  resetPreferences()
                  setConfirming(false)
                  setDone('every setting back to its default')
                }}
              />
              <Action
                label="Keep them"
                title="Leave everything as it is"
                onClick={() => setConfirming(false)}
              />
            </>
          ) : (
            <Action
              label="Reset Everything"
              title="Forget every setting this browser holds"
              onClick={() => setConfirming(true)}
            />
          )}
        </div>
      </div>

      <p className="type-micro text-slate-400">
        {REGISTRY.length} settings in {PREFERENCE_GROUPS.length} groups, plus
        the per-panel and per-mode ones.
      </p>
    </div>
  )
}
