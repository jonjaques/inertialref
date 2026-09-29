import { Link, useLocation } from 'react-router'
import { UserButton, useAuth } from '@clerk/react'
import { CircleUserRound } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING } from '../hud/focus.ts'
import {
  overlayState,
  PROFILE,
  resolvedLocation,
  SIGN_IN,
} from '../pages/paths.ts'

/**
 * The account control itself: a sign-in link, or the signed-in badge.
 *
 * The badge is Clerk's `UserButton` — the avatar, and a popover with the
 * profile and sign-out — because the popover is account UI Clerk keeps
 * current and this repository should not. What it does *not* get to do is
 * open Clerk's own modal for the profile: `navigation` mode sends "Manage
 * account" to `/profile` through the router, where it is a dialog over the
 * running mode like every other one, with an address and a close button.
 *
 * While Clerk is still loading this holds the space and draws nothing. The
 * badge and the link are the same size, so the bar does not shift when the
 * answer arrives — and if Clerk never loads (a blocked script, no network) the
 * bar is one blank slot wide rather than carrying a sign-in link that leads to
 * a form that cannot appear.
 */
export function AccountButton({
  compact,
  side,
}: {
  compact: boolean
  side: 'top' | 'bottom'
}) {
  const { isLoaded, isSignedIn } = useAuth()
  const location = useLocation()
  const size = compact ? 'size-11' : 'size-7'

  if (!isLoaded) return <span aria-hidden className={`${size} shrink-0`} />

  if (isSignedIn)
    return (
      <span className={`flex ${size} shrink-0 items-center justify-center`}>
        <UserButton
          userProfileMode="navigation"
          userProfileUrl={PROFILE}
          appearance={{
            elements: {
              // 20 px inside a 28 px slot: the avatar is a face, and at the
              // glyphs' own 16 px it stops reading as one.
              userButtonAvatarBox: compact ? 'size-7' : 'size-5',
              userButtonTrigger: `rounded-full ${FOCUS_RING}`,
            },
          }}
        />
      </span>
    )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={SIGN_IN}
          // The mode behind, not this address: from inside a dialog the raw
          // location is the dialog's, and carrying it would make the sign-in
          // page its own background.
          state={overlayState(resolvedLocation(location))}
          aria-label="Sign in"
          className={`flex ${size} shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-sky-200 ${FOCUS_RING}`}
        >
          <CircleUserRound aria-hidden className="size-4" />
        </Link>
      </TooltipTrigger>
      <TooltipContent side={side}>Sign in</TooltipContent>
    </Tooltip>
  )
}
