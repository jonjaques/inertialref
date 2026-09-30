import { useLocation } from 'react-router'
import { UserButton, useAuth, useClerk } from '@clerk/react'
import { CircleUserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { FOCUS_RING, releaseFocus } from '../hud/focus.ts'
import { resolvedLocation } from '../pages/paths.ts'

/**
 * The account control inside a mode: a sign-in button, or the signed-in badge
 * — and both open Clerk's own modal, never an address.
 *
 * A mode is a place with a camera, a clock and a flight in it, and the URL is
 * what says which one (`pages/paths.ts`). Sending the visitor to `/sign-in` to
 * answer "who am I signed in as" would leave that place; a modal answers it
 * over the running scene and closes back onto it. The pages at `/sign-in` and
 * `/profile` are for arriving by address or from the menu.
 *
 * Signing in from the modal returns to the address it was opened at, which
 * `accountNavigation` recognizes as nowhere to go. Signing out from the
 * badge's popover lands on the same address for the same reason.
 *
 * While Clerk is still loading this holds the space and draws nothing. The
 * badge and the button are the same size, so the bar does not shift when the
 * answer arrives — and if Clerk never loads (a blocked script, no network) the
 * bar is one blank slot wide rather than carrying a sign-in button that opens
 * nothing.
 */
export function AccountButton({
  compact,
  side,
}: {
  compact: boolean
  side: 'top' | 'bottom'
}) {
  const { isLoaded, isSignedIn } = useAuth()
  const clerk = useClerk()
  const location = useLocation()
  const size = compact ? 'size-11' : 'size-7'

  if (!isLoaded) return <span aria-hidden className={`${size} shrink-0`} />

  if (isSignedIn)
    return (
      <span className={`flex ${size} shrink-0 items-center justify-center`}>
        <UserButton
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

  const back = resolvedLocation(location)
  const here = `${back.pathname}${back.search}${back.hash}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          aria-label="Sign in"
          onClick={(event) => {
            releaseFocus(event)
            clerk.openSignIn({
              forceRedirectUrl: here,
              signUpForceRedirectUrl: here,
            })
          }}
          className={`${size} shrink-0 rounded p-0 text-slate-400 hover:bg-slate-800/60 hover:text-sky-200 ${FOCUS_RING}`}
        >
          <CircleUserRound aria-hidden className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>Sign in</TooltipContent>
    </Tooltip>
  )
}
