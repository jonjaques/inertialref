import { useState } from 'react'
import { Check, Pencil, RefreshCw, Share2, Trash2, X } from 'lucide-react'
import type { Picture } from '@inertialref/devtools'
import { Input } from '@/components/ui/input'
import { Action } from '../hud/Action.tsx'
import { TransportButton } from '../hud/TransportButton.tsx'
import { SharePicture } from './SharePicture.tsx'

export function SavedPictureRow({
  picture,
  onTake,
  onRename,
  onReplace,
  onDelete,
  onNotice,
}: {
  picture: Picture
  onTake: () => void
  onRename: (name: string) => void
  onReplace: () => void
  onDelete: () => void
  onNotice: (message: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [name, setName] = useState(picture.label)
  return (
    <div className="flex flex-col gap-2 border-b border-slate-800 py-3">
      {editing ? (
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) {
              onRename(name.trim())
              setEditing(false)
            }
          }}
        >
          <Input
            aria-label="Rename preset"
            autoFocus
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
          <Action
            label="Save name"
            icon={Check}
            type="submit"
            disabled={!name.trim()}
          />
          <TransportButton
            label="Cancel rename"
            icon={X}
            onClick={() => setEditing(false)}
          />
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Action
            label={picture.label}
            onClick={onTake}
            className="mr-auto max-w-full truncate"
            title={`Open ${picture.label}`}
          />
          <div className="flex gap-1">
            <TransportButton
              label={`Rename ${picture.label}`}
              icon={Pencil}
              onClick={() => {
                setName(picture.label)
                setEditing(true)
              }}
            />
            <TransportButton
              label={`Replace ${picture.label} with current view`}
              icon={RefreshCw}
              onClick={onReplace}
            />
            <TransportButton
              label={`Share ${picture.label}`}
              icon={Share2}
              primary={sharing}
              onClick={() => setSharing(!sharing)}
            />
            <TransportButton
              label={`Delete ${picture.label}`}
              icon={Trash2}
              onClick={onDelete}
            />
          </div>
        </div>
      )}
      {sharing && <SharePicture picture={picture} onNotice={onNotice} />}
    </div>
  )
}
