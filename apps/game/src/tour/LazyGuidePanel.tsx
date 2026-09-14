import { lazy } from 'react'

export const LazyGuidePanel = lazy(() =>
  import('./GuidePanel.tsx').then((module) => ({ default: module.GuidePanel })),
)
