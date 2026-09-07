import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { PICTURES, type Picture } from '@inertialref/devtools'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { GameEngine } from '../engine/GameEngine.ts'
import { OverlayPage } from '../pages/OverlayPage.tsx'
import { CurrentPicture } from './CurrentPicture.tsx'
import { SavedPictures } from './SavedPictures.tsx'
import { PictureCard } from './PictureCard.tsx'
import { SharePicture } from './SharePicture.tsx'
import { pictureLink, presetLink, withPictureLink } from './presetUrl.ts'
import { describeCause } from '../hud/notice.ts'

export function PresetsPage({ engine }: { engine: GameEngine }) {
  const [params] = useSearchParams()
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [sharing, setSharing] = useState<Picture | null>(null)
  const navigate = useNavigate()
  const take = (picture: Picture, builtin = false) => {
    try {
      // Validate before leaving the dialog so an incompatible import keeps its explanation visible.
      engine.harness.takePicture(picture)
      const search = withPictureLink(
        params,
        builtin ? presetLink(picture.id) : pictureLink(picture),
      )
      search.delete('capture')
      search.delete('name')
      void navigate(`/planetarium?${search}`, { replace: true })
    } catch (cause) {
      setNotice(describeCause(cause))
    }
  }
  return (
    <OverlayPage title="Presets" wide modal>
      <Tabs
        defaultValue={params.get('capture') === '1' ? 'current' : 'included'}
      >
        <TabsList variant="line" aria-label="Preset library">
          <TabsTrigger value="included">Included</TabsTrigger>
          <TabsTrigger value="saved">Saved</TabsTrigger>
          <TabsTrigger value="current">Current view</TabsTrigger>
        </TabsList>
        {notice && (
          <p
            role="status"
            className="type-ui border-b border-slate-800 pb-2 text-sky-200"
          >
            {notice}
          </p>
        )}
        <TabsContent value="included" className="flex flex-col gap-3">
          <Input
            aria-label="Find included preset"
            placeholder="Find a planet, moon, or shot"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {sharing !== null && (
            <div className="border-b border-slate-800 pb-3">
              <p className="type-ui mb-2 text-slate-200">
                Share {sharing.label}
              </p>
              <SharePicture picture={sharing} builtin onNotice={setNotice} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {PICTURES.filter((one) =>
              `${one.label} ${one.why}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            ).map((picture) => (
              <div key={picture.id} className="flex min-w-0 flex-col gap-1">
                <PictureCard
                  picture={picture}
                  onTake={() => take(picture, true)}
                />
                <button
                  type="button"
                  className="type-ui min-h-7 text-slate-400 hover:text-sky-200 focus-visible:outline focus-visible:outline-sky-400"
                  aria-label={`Share ${picture.label}`}
                  onClick={() => setSharing(picture)}
                >
                  Share
                </button>
              </div>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="saved">
          <SavedPictures engine={engine} onNotice={setNotice} onTake={take} />
        </TabsContent>
        <TabsContent value="current">
          <CurrentPicture
            engine={engine}
            onNotice={setNotice}
            initialName={params.get('name') ?? undefined}
          />
        </TabsContent>
      </Tabs>
    </OverlayPage>
  )
}
