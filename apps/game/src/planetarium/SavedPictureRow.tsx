import { useState } from 'react'
import type { Picture } from '@inertialref/devtools'
import { Input } from '@/components/ui/input'
import { Action } from '../hud/Action.tsx'
import { downloadPictures } from './presetFiles.ts'

export function SavedPictureRow({
  picture,
  onTake,
  onRename,
  onReplace,
  onDelete,
}: {
  readonly picture: Picture
  readonly onTake: () => void
  readonly onRename: (name: string) => void
  readonly onReplace: () => void
  readonly onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(picture.label)
  return (
    <div className="flex flex-col gap-1.5 rounded border border-slate-700/70 p-2">
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!name.trim()) return
            onRename(name.trim())
            setEditing(false)
          }}
          className="flex gap-1"
        >
          <Input
            aria-label="Preset Name"
            autoFocus
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <Action label="Save" type="submit" disabled={!name.trim()} />
          <Action label="Cancel" onClick={() => setEditing(false)} />
        </form>
      ) : (
        <Action
          label={picture.label}
          onClick={onTake}
          title={picture.why || picture.address}
        />
      )}
      <div className="flex flex-wrap gap-1">
        <Action
          label="Rename"
          onClick={() => {
            setName(picture.label)
            setEditing(true)
          }}
        />
        <Action
          label="Update Shot"
          title="Replace this preset with the current camera, time and lens"
          onClick={onReplace}
        />
        <Action
          label="Export"
          onClick={() => downloadPictures([picture], picture.id)}
        />
        <Action label="Delete" onClick={onDelete} />
      </div>
    </div>
  )
}
