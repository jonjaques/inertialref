import { useRef, useState } from 'react'
import {
  decodePictures,
  mergePictures,
  MAX_PICTURE_BYTES,
  MAX_PICTURES,
  PICTURES,
  type Picture,
} from '@inertialref/devtools'
import { Input } from '@/components/ui/input'
import { Action } from '../hud/Action.tsx'
import { Section } from '../hud/Section.tsx'
import { describeCause } from '../hud/notice.ts'
import { PERSONAL_PICTURES, usePersistentState } from '../state/preferences.ts'
import type { PlanetariumContext } from './context.ts'
import { downloadPictures } from './presetFiles.ts'
import { SavedPictureRow } from './SavedPictureRow.tsx'

export function SavedPictures({ engine, onNotice }: PlanetariumContext) {
  const [pictures, setPictures] = usePersistentState(PERSONAL_PICTURES)
  const [name, setName] = useState('')
  const [deleted, setDeleted] = useState<Picture | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const attempt = (work: () => void) => {
    try {
      work()
    } catch (cause) {
      onNotice(describeCause(cause))
    }
  }
  return (
    <Section
      id="planetarium.presets.personal"
      title="My Presets"
      trailing={`${pictures.length}`}
    >
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          attempt(() => {
            const picture = engine.harness.capturePicture(
              `shot-${crypto.randomUUID()}`,
              name,
            )
            setPictures((held) => mergePictures(held, [picture]))
            setName('')
            onNotice(`Saved ${picture.label}`)
          })
        }}
      >
        <Input
          aria-label="New Preset Name"
          placeholder="Name This Shot"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
        <Action
          label="Save Shot"
          type="submit"
          disabled={!name.trim() || pictures.length >= MAX_PICTURES}
        />
      </form>
      <p className="type-ui my-1.5 text-pretty text-slate-400">
        Save the current camera, time and lens. Presets stay in this browser;
        export a copy to keep or share.
      </p>
      <div className="mb-2 flex flex-wrap gap-1">
        <Action label="Import" onClick={() => input.current?.click()} />
        <Action
          label="Export Mine"
          disabled={pictures.length === 0}
          onClick={() => downloadPictures(pictures)}
        />
        <Action
          label="Export All"
          onClick={() => downloadPictures(mergePictures(pictures, PICTURES))}
        />
      </div>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-label="Import Presets"
        onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          try {
            if (file.size > MAX_PICTURE_BYTES)
              throw new Error('Preset files must be smaller than 2 MB.')
            const incoming = decodePictures(JSON.parse(await file.text()))
            setPictures((held) => mergePictures(held, incoming))
            onNotice(
              `Imported ${incoming.length} presets. Existing shots are kept.`,
            )
          } catch (cause) {
            onNotice(describeCause(cause))
          }
        }}
      />
      <div className="flex flex-col gap-1.5">
        {pictures.map((picture) => (
          <SavedPictureRow
            key={picture.id}
            picture={picture}
            onTake={() =>
              attempt(() => {
                engine.harness.takePicture(picture)
                onNotice(picture.label)
              })
            }
            onRename={(label) =>
              setPictures((held) =>
                held.map((one) =>
                  one.id === picture.id ? { ...one, label } : one,
                ),
              )
            }
            onReplace={() =>
              attempt(() => {
                const replacement = engine.harness.capturePicture(
                  picture.id,
                  picture.label,
                  picture.why,
                )
                setPictures((held) =>
                  held.map((one) =>
                    one.id === picture.id ? replacement : one,
                  ),
                )
                onNotice(`Updated ${picture.label}`)
              })
            }
            onDelete={() => {
              setPictures((held) => held.filter((one) => one.id !== picture.id))
              setDeleted(picture)
            }}
          />
        ))}
      </div>
      {deleted !== null && (
        <div className="mt-2 flex items-center gap-2">
          <span className="type-ui text-slate-400">
            Deleted {deleted.label}
          </span>
          <Action
            label="Undo"
            onClick={() =>
              attempt(() => {
                setPictures((held) => mergePictures(held, [deleted]))
                setDeleted(null)
              })
            }
          />
        </div>
      )}
    </Section>
  )
}
