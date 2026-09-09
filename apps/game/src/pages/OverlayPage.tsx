import { useEffect, useRef, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAction, useActionTitle, useKeyContext } from '../input/useKeymap.ts'
import { useOverlay } from './useOverlay.ts'

/** A routed dialog over the running scene. Modal tasks also contain keyboard focus. */
export function OverlayPage({
  title,
  subtitle,
  wide = false,
  modal = false,
  fill = false,
  children,
}: {
  title: string
  subtitle?: string
  wide?: boolean
  modal?: boolean
  /**
   * Give the body the dialog's remaining height and let the content scroll
   * itself, instead of scrolling the body.
   *
   * For a dialog holding a long list beside controls that must stay put. The
   * default is right for every dialog whose content is prose or a form — the
   * body scrolls and the dialog is as tall as it needs to be — and it is wrong
   * for a windowed list, which needs a scroll container with a *definite*
   * height to measure its window against. Without one the list has no bound to
   * window to and renders every row, which is the cost the windowing exists to
   * avoid.
   */
  fill?: boolean
  children: ReactNode
}) {
  const { close } = useOverlay()
  const closeTitle = useActionTitle('overlay.close', 'Close')
  useKeyContext({ context: 'dialog' })
  useAction('overlay.close', close)
  const panel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const opener = document.activeElement
    const node = panel.current
    node?.focus({ preventScroll: true })
    return () => {
      const active = document.activeElement
      if (
        (active === null ||
          active === document.body ||
          node?.contains(active)) &&
        opener instanceof HTMLElement &&
        opener !== document.body &&
        opener.isConnected
      )
        opener.focus({ preventScroll: true })
    }
  }, [])

  const heading = <h1 className="type-title text-slate-100">{title}</h1>
  const body = (
    <motion.div
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-modal={modal}
      aria-label={title}
      className={`type-body flex max-h-[calc(100%-4rem)] ${wide ? 'w-[56rem]' : 'w-[34rem]'} max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-lg border border-slate-700/60 bg-slate-950/85 text-slate-300 shadow-xl outline-none`}
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.18 }}
    >
      <header className="flex items-baseline gap-3 border-b border-slate-800 px-4 py-2.5">
        {modal ? <Dialog.Title asChild>{heading}</Dialog.Title> : heading}
        {subtitle !== undefined && (
          <span
            className="type-ui min-w-0 truncate text-slate-400"
            title={subtitle}
          >
            {subtitle}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto text-slate-400 hover:text-sky-200"
          aria-label={closeTitle}
          title={closeTitle}
          onClick={close}
        >
          <X />
        </Button>
      </header>
      <div
        className={`min-h-0 px-4 py-3 ${
          fill ? 'flex flex-1 flex-col overflow-hidden' : 'overflow-y-auto'
        }`}
      >
        {children}
      </div>
    </motion.div>
  )

  // Keep the content in .hud-layer so its material stays at standard range.
  const scrim = (
    <motion.div
      className="hud-bleed pointer-events-auto absolute flex items-center justify-center bg-slate-950/70"
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      {modal ? (
        <Dialog.Content
          asChild
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            close()
          }}
        >
          {body}
        </Dialog.Content>
      ) : (
        body
      )}
    </motion.div>
  )
  return modal ? (
    <Dialog.Root open modal>
      {scrim}
    </Dialog.Root>
  ) : (
    scrim
  )
}
