import { Separator } from '@/components/ui/separator'
import { AccountButton } from './AccountButton.tsx'
import { useAccounts } from './accounts.ts'

/**
 * Who is signed in, at the end of the menu — or nothing, in a build that has
 * no accounts.
 *
 * Two components rather than one with an early return, because the other half
 * calls Clerk's hooks and those throw outside the provider. The server-render
 * tests draw the menu with no provider at all, and so does a fork.
 *
 * The separator is drawn here rather than by the menu, so that a build with no
 * accounts does not end its bar on a divider with nothing after it.
 */
export function AccountBadge({
  compact = false,
  side = 'top',
  divider = false,
}: {
  /** Thumb scale, for the phone's nav bar. */
  compact?: boolean
  /** Which way the hint opens: away from the edge the bar is attached to. */
  side?: 'top' | 'bottom'
  divider?: boolean
}) {
  if (!useAccounts()) return null
  return (
    <>
      {divider && (
        <Separator
          orientation="vertical"
          className={`mx-0.5 ${compact ? '!h-5' : '!h-4'} bg-slate-800`}
        />
      )}
      <AccountButton compact={compact} side={side} />
    </>
  )
}
