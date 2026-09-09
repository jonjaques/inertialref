import type { ReactNode } from 'react'
import { BrowserRouter, StaticRouter } from 'react-router'

/** React owns navigation so changing a document never replaces the canvas. */
export function ShellRouter({
  url,
  children,
}: {
  url: string
  children: ReactNode
}) {
  return typeof window === 'undefined' ? (
    <StaticRouter location={url}>{children}</StaticRouter>
  ) : (
    <BrowserRouter useTransitions={false}>{children}</BrowserRouter>
  )
}
