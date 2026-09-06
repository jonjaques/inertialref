import { useState } from 'react'
import { instantMillis, SIMULATION_EPOCH_UTC_MS } from '@inertialref/shared'
import { Input } from '@/components/ui/input'
import { Action } from '../hud/Action.tsx'
import type { PlanetariumContext } from './context.ts'

export function PictureTime({ engine, onNotice }: PlanetariumContext) {
  const [value, setValue] = useState('')
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        const millis = Date.parse(`${value}Z`)
        if (!Number.isFinite(millis)) {
          onNotice('Choose a valid UTC date and time.')
          return
        }
        engine.harness.observatory.setTime(
          (millis - SIMULATION_EPOCH_UTC_MS) / 1000,
        )
      }}
    >
      <label className="type-ui text-slate-400" htmlFor="preset-time">
        Choose Time (UTC)
      </label>
      <div className="flex gap-1">
        <Input
          id="preset-time"
          type="datetime-local"
          step="1"
          value={value}
          onFocus={() => {
            if (!value)
              setValue(
                new Date(instantMillis(engine.harness.observatory.time))
                  .toISOString()
                  .slice(0, 19),
              )
          }}
          onChange={(event) => setValue(event.target.value)}
        />
        <Action label="Set" type="submit" disabled={!value} />
      </div>
    </form>
  )
}
