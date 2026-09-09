import { createContext } from 'react'
import type { DocManifest, DocPage } from './content.ts'
import type { Loaded } from './useDocs.ts'

/** The document carried by this HTML response, before any client fetch. */
export interface InitialDocs {
  readonly manifest: DocManifest
  readonly page: DocPage | null
}

export interface DocsContent {
  readonly manifest: Loaded<DocManifest>
  readonly page: Loaded<DocPage>
}

/** A request owns its content. Concurrent server renders share no page state. */
export const DocsContentContext = createContext<DocsContent | null>(null)
