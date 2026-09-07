'use no memo'
import { useState } from 'react'
import { Camera, Save } from 'lucide-react'
import { instantMillis } from '@inertialref/shared'
import { mergePictures, type Picture } from '@inertialref/devtools'
import { Input } from '@/components/ui/input'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Action } from '../hud/Action.tsx'
import { describeCause } from '../hud/notice.ts'
import { PERSONAL_PICTURES, usePersistentState } from '../state/preferences.ts'
import { SharePicture } from './SharePicture.tsx'

export function CurrentPicture({
  engine,
  onNotice,
  initialName,
}: {
  engine: GameEngine
  initialName?: string
  onNotice: (message: string) => void
}) {
  const capture = (): { picture: Picture | null; error: string } => {
    try {
      return {
        picture: engine.harness.capturePicture(
          `shot-${crypto.randomUUID()}`,
          engine.harness.observatory.target?.name ?? 'Untitled',
        ),
        error: '',
      }
    } catch (cause) {
      return { picture: null, error: describeCause(cause) }
    }
  }
  const [shot, setShot] = useState(capture)
  const [name, setName] = useState(initialName ?? shot.picture?.label ?? '')
  const [, setPictures] = usePersistentState(PERSONAL_PICTURES)
  const picture =
    shot.picture === null
      ? null
      : { ...shot.picture, label: name.trim() || shot.picture.label }
  return (
    <div className="flex flex-col gap-4">
      {picture === null ? (
        <p className="type-ui text-slate-400">{shot.error}</p>
      ) : (
        <>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              try {
                setPictures((held) => mergePictures(held, [picture]))
                onNotice(`Saved ${picture.label}.`)
              } catch (cause) {
                onNotice(describeCause(cause))
              }
            }}
          >
            <Input
              aria-label="Preset name"
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Action
              label="Save preset"
              icon={Save}
              type="submit"
              tone="primary"
              disabled={!name.trim()}
            />
          </form>
          <div className="type-readout flex flex-col gap-1 text-slate-400">
            <span>
              {new Date(instantMillis(picture.time))
                .toISOString()
                .replace('T', ' ')
                .replace('.000Z', ' UTC')}
            </span>
            <span className="break-all">{picture.address}</span>
          </div>
          <SharePicture picture={picture} onNotice={onNotice} />
        </>
      )}
      <div className="flex items-center gap-3 border-t border-slate-800 pt-3">
        <Action
          label="Recapture"
          icon={Camera}
          title="Capture the camera and time currently on screen"
          onClick={() => setShot(capture())}
        />
        <p className="type-ui text-slate-400">
          Camera, target, time, and lens are captured when this tab opens.
        </p>
      </div>
    </div>
  )
}
