import { useState } from 'react'
import { CalendarDays, Check, Clock3 } from 'lucide-react'
import { instantMillis, SIMULATION_EPOCH_UTC_MS } from '@inertialref/shared'
import { Input } from '@/components/ui/input'
import { Action } from '../hud/Action.tsx'
import { describeCause } from '../hud/notice.ts'
import type { PlanetariumContext } from './context.ts'

export function PictureTime({ engine, onNotice }: PlanetariumContext) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const setDate = (millis: number) => {
    try {
      if (!Number.isFinite(millis))
        throw new Error('Enter a valid UTC date and time.')
      engine.harness.observatory.setTime(
        (millis - SIMULATION_EPOCH_UTC_MS) / 1000,
      )
      setEditing(false)
    } catch (cause) {
      onNotice(describeCause(cause))
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Action
          label="Set date"
          icon={CalendarDays}
          onClick={() => {
            setValue(
              new Date(instantMillis(engine.harness.observatory.time))
                .toISOString()
                .slice(0, 19),
            )
            setEditing(!editing)
          }}
        />
        <Action
          label="Now"
          icon={Clock3}
          title="Set the view to the current date and time"
          onClick={() => setDate(Date.now())}
        />
      </div>
      {editing && (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            setDate(Date.parse(`${value}Z`))
          }}
        >
          <label className="type-ui text-slate-400" htmlFor="preset-time">
            Date and time (UTC)
          </label>
          <div className="flex gap-1">
            <Input
              id="preset-time"
              type="datetime-local"
              step="1"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            <Action
              label="Apply"
              icon={Check}
              type="submit"
              disabled={!value}
            />
          </div>
        </form>
      )}
    </div>
  )
}
