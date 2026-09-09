import { useRef, useState } from 'react'
import { Download, FileUp, ClipboardPaste, Undo2 } from 'lucide-react'
import {
  decodePictures,
  mergePictures,
  MAX_PICTURE_BYTES,
  MAX_FILE_PICTURES,
  PICTURES,
  type Picture,
} from '@inertialref/devtools'
import { Input } from '@/components/ui/input'
import type { GameEngine } from '../engine/GameEngine.ts'
import { Action } from '../hud/Action.tsx'
import { describeCause } from '../hud/notice.ts'
import { PERSONAL_PICTURES, usePersistentState } from '../state/preferences.ts'
import { downloadPictures } from './presetFiles.ts'
import { SavedPictureRow } from './SavedPictureRow.tsx'

export function SavedPictures({
  engine,
  onNotice,
  onTake,
}: {
  engine: GameEngine
  onNotice: (message: string) => void
  onTake: (picture: Picture) => void
}) {
  const [pictures, setPictures] = usePersistentState(PERSONAL_PICTURES)
  const [deleted, setDeleted] = useState<Picture | null>(null)
  const [query, setQuery] = useState('')
  const [pasting, setPasting] = useState(false)
  const [paste, setPaste] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const attempt = (work: () => void) => {
    try {
      work()
    } catch (cause) {
      onNotice(describeCause(cause))
    }
  }
  const importText = (text: string) => {
    if (new TextEncoder().encode(text).length > MAX_PICTURE_BYTES)
      throw new Error('Preset files must be smaller than 2 MB.')
    const incoming = decodePictures(JSON.parse(text))
    setPictures((held) => mergePictures(held, incoming))
    onNotice('Import complete. Duplicate shots are skipped.')
    setPaste('')
    setPasting(false)
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Action
          label="Import file"
          icon={FileUp}
          onClick={() => input.current?.click()}
        />
        <Action
          label="Paste JSON"
          icon={ClipboardPaste}
          onClick={() => setPasting(!pasting)}
        />
        <Action
          label="Export saved"
          icon={Download}
          disabled={pictures.length === 0}
          onClick={() => downloadPictures(pictures)}
        />
        <Action
          label="Export all"
          icon={Download}
          onClick={() =>
            downloadPictures(
              mergePictures(pictures, PICTURES, MAX_FILE_PICTURES),
            )
          }
        />
      </div>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-label="Import presets"
        onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          try {
            if (file.size > MAX_PICTURE_BYTES)
              throw new Error('Preset files must be smaller than 2 MB.')
            importText(await file.text())
          } catch (cause) {
            onNotice(describeCause(cause))
          }
        }}
      />
      {pasting && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            attempt(() => importText(paste))
          }}
        >
          <textarea
            aria-label="Preset JSON"
            placeholder="Paste a preset or library JSON"
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
            className="type-readout h-32 w-full rounded border border-slate-700 bg-slate-900 p-2 text-slate-200"
          />
          <Action label="Import JSON" type="submit" disabled={!paste.trim()} />
        </form>
      )}
      {pictures.length > 5 && (
        <Input
          aria-label="Find saved preset"
          placeholder="Find a saved preset"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {pictures.length === 0 && (
        <p className="type-ui py-4 text-slate-400">
          No saved presets. Open Current view to save your first shot, or import
          one above.
        </p>
      )}
      <div>
        {pictures
          .filter((one) =>
            one.label.toLowerCase().includes(query.toLowerCase()),
          )
          .map((picture) => (
            <SavedPictureRow
              key={picture.id}
              picture={picture}
              onNotice={onNotice}
              onTake={() => onTake(picture)}
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
                  onNotice(`Updated ${picture.label}.`)
                })
              }
              onDelete={() => {
                setPictures((held) =>
                  held.filter((one) => one.id !== picture.id),
                )
                setDeleted(picture)
              }}
            />
          ))}
      </div>
      {deleted !== null && (
        <div className="flex items-center gap-2">
          <span className="type-ui text-slate-400">
            Deleted {deleted.label}.
          </span>
          <Action
            label="Undo"
            icon={Undo2}
            onClick={() =>
              attempt(() => {
                setPictures((held) => mergePictures(held, [deleted]))
                setDeleted(null)
              })
            }
          />
        </div>
      )}
      <p className="type-ui text-slate-400">
        Saved in this browser. Export a file for backup.
      </p>
    </div>
  )
}
