import { useState } from 'react'
import { Input } from '@/components/ui/input'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { CloudsTunable } from '../render/cloudsTunables.ts'
import { useEngine } from '../state/engineStore.ts'
import { Action } from './Action.tsx'

function parseValue(field: CloudsTunable, text: string): unknown {
  if (field.kind === 'enum') return text
  if (field.path === 'shadow.maxFar' && text.trim() === 'null') return null
  const value: unknown = JSON.parse(text)
  if (field.kind === 'boolean' && typeof value === 'boolean') return value
  if (field.kind === 'number' && Number.isFinite(value)) return value
  if (field.kind === 'integer' && Number.isSafeInteger(value)) return value
  if (
    (field.kind === 'vec2' || field.kind === 'vec3') &&
    Array.isArray(value) &&
    value.length === (field.kind === 'vec2' ? 2 : 3) &&
    value.every(Number.isFinite)
  )
    return value
  throw new TypeError(`Expected ${field.kind}.`)
}

/** One setting at a time from the port's own table, including its experimental switches. */
export function CloudTunablesPanel({ engine }: { engine: GameEngine }) {
  'use no memo'
  const available = useEngine((snapshot) => snapshot.cloudsAvailable)
  const [path, select] = useState('coverage')
  const [draft, setDraft] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const handle = engine.cloudTunables
  const field = handle?.tunables.find((candidate) => candidate.path === path)
  if (!available || !handle || !field)
    return (
      <p className="type-ui">
        Cloud tuning requires volumetric clouds on WebGPU.
      </p>
    )
  const live = handle.read()?.[path]
  const value =
    draft ?? (typeof live === 'string' ? live : (JSON.stringify(live) ?? ''))
  const choices = field.kind === 'boolean' ? ['true', 'false'] : field.values
  const control =
    'type-ui min-w-0 w-full rounded border border-slate-700 bg-slate-950 p-1'
  return (
    <form
      className="grid gap-2 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        try {
          const parsed = parseValue(field, value)
          handle.set({ [path]: parsed })
          setStatus(`Applied ${value}.`)
        } catch (cause) {
          setStatus(cause instanceof Error ? cause.message : String(cause))
        }
      }}
    >
      <label className="type-label">
        Tunable
        <select
          className={control}
          value={path}
          onChange={(event) => {
            select(event.target.value)
            setDraft(null)
            setStatus('')
          }}
        >
          {handle.tunables.map(({ path: option }) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
      <p className="type-ui text-slate-400">{field.what}</p>
      <label className="type-label">
        Value
        {choices ? (
          <select
            className={control}
            value={value}
            onChange={(event) => setDraft(event.target.value)}
          >
            {choices.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        ) : (
          <Input
            value={value}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
      </label>
      <Action type="submit" label="Apply" disabled={live === undefined} />
      <output className="type-ui" aria-live="polite">
        {status}
      </output>
    </form>
  )
}
