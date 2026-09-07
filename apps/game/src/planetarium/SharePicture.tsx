import { useState } from 'react'
import { Copy, Download, Link } from 'lucide-react'
import { encodePictures, type Picture } from '@inertialref/devtools'
import { Action } from '../hud/Action.tsx'
import { SwitchRow } from '../hud/SwitchRow.tsx'
import { describeCause } from '../hud/notice.ts'
import { pictureLink, presetLink } from './presetUrl.ts'
import { downloadPictures } from './presetFiles.ts'

export function SharePicture({
  picture,
  builtin = false,
  onNotice,
}: {
  picture: Picture
  builtin?: boolean
  onNotice: (message: string) => void
}) {
  const [offerSave, setOfferSave] = useState(true)
  const [fallback, setFallback] = useState('')
  const copy = async (kind: 'json' | 'link') => {
    let text = ''
    try {
      text =
        kind === 'json'
          ? encodePictures([picture])
          : new URL(
              builtin
                ? `${presetLink(picture.id)}${offerSave ? '&save=1' : ''}`
                : pictureLink(picture, offerSave),
              window.location.origin,
            ).href
      await navigator.clipboard.writeText(text)
      setFallback('')
      onNotice(kind === 'json' ? 'JSON copied.' : 'Link copied.')
    } catch (cause) {
      setFallback(text)
      onNotice(text ? 'Select and copy the text below.' : describeCause(cause))
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Action
          label="Copy link"
          icon={Link}
          onClick={() => void copy('link')}
        />
        <Action
          label="Copy JSON"
          icon={Copy}
          onClick={() => void copy('json')}
        />
        <Action
          label="Download"
          icon={Download}
          title="Download this preset as JSON"
          onClick={() => downloadPictures([picture], picture.id)}
        />
      </div>
      <SwitchRow
        label="Offer to save when opened"
        on={offerSave}
        onChange={setOfferSave}
      />
      {fallback && (
        <textarea
          aria-label="Share text"
          readOnly
          value={fallback}
          onFocus={(event) => event.target.select()}
          className="type-readout h-24 w-full rounded border border-slate-700 bg-slate-900 p-2 text-slate-200"
        />
      )}
    </div>
  )
}
