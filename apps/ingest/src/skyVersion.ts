import { createHash } from 'node:crypto'
import { encodeCatalog, type PackedCatalog } from '@inertialref/universe'

/** Provenance text is descriptive; selection bounds change the catalog's meaning. */
export function skyVersion(catalog: PackedCatalog): string {
  const bytes = encodeCatalog({
    ...catalog,
    metadata: {
      version: '',
      radiusLightYears: 0,
      completeRadiusLightYears: 0,
      attribution: [],
      sources: [],
      ...(catalog.metadata.sky === undefined
        ? {}
        : { sky: catalog.metadata.sky }),
    },
  })
  return `sky-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}`
}
