import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { PICTURES, type Picture } from '@inertialref/devtools'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { GameEngine } from '../engine/GameEngine.ts'
import { OverlayPage } from '../pages/OverlayPage.tsx'
import { CurrentPicture } from './CurrentPicture.tsx'
import { SavedPictures } from './SavedPictures.tsx'
import { PictureCard } from './PictureCard.tsx'
import { SharePicture } from './SharePicture.tsx'
import { pictureLink, presetLink, withPictureLink } from './presetUrl.ts'
import { FOCUS_RING } from '../hud/focus.ts'
import { describeCause } from '../hud/notice.ts'
import { SearchField } from '../hud/SearchField.tsx'

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
        {/*
         * The settings page's tab row, through the registry's tabs: the label
         * step, an underline in the structural accent on the current one, and
         * the row's hairline under all three. The registry's own line variant
         * drew a 14px medium label and a foreground-white underline — a second
         * tab language in the one interface that has two dialogs with tabs.
         */}
        <TabsList
          variant="line"
          aria-label="Preset library"
          className="-mx-4 -mt-3 mb-1 w-auto justify-start gap-1 border-b border-slate-800 px-3 py-0 group-data-[orientation=horizontal]/tabs:h-auto"
        >
          {(
            [
              ['included', 'Included'],
              ['saved', 'Saved'],
              ['current', 'Current view'],
            ] as const
          ).map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className={`type-label h-10 flex-none rounded-none px-2.5 text-slate-400 transition-colors group-data-[orientation=horizontal]/tabs:after:inset-x-2 group-data-[orientation=horizontal]/tabs:after:-bottom-px after:rounded-full after:bg-sky-400 hover:text-slate-200 focus-visible:ring-0 data-[state=active]:text-sky-200 ${FOCUS_RING}`}
            >
              {label}
            </TabsTrigger>
          ))}
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
          <SearchField
            value={query}
            onChange={setQuery}
            label="Find included preset"
            placeholder="Find a planet, moon, or shot"
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
