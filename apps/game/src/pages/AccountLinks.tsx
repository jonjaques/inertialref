import { CircleUserRound, LogIn, UserRoundPlus } from 'lucide-react'
import { useAccount } from '../account/accounts.ts'
import { FooterLink } from './FooterLink.tsx'
import { PROFILE, SIGN_IN, SIGN_UP } from './paths.ts'

/**
 * The account pages, from the front door: the way in, or the way to what you
 * signed in as.
 *
 * Nothing until the provider has answered, rather than a guess. Server HTML
 * and the first client render know nobody, so drawing "Sign in" there would
 * put it in front of every signed-in visitor for the second it takes Clerk to
 * say otherwise — and nothing at all in a build without accounts.
 */
export function AccountLinks() {
  const { configured, loaded, userId } = useAccount()
  if (!configured || !loaded) return null
  if (userId !== null)
    return (
      <FooterLink to={PROFILE} icon={CircleUserRound} label="Your account" />
    )
  return (
    <>
      <FooterLink to={SIGN_IN} icon={LogIn} label="Sign in" />
      <FooterLink to={SIGN_UP} icon={UserRoundPlus} label="Create an account" />
    </>
  )
}
