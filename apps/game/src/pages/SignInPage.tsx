import { OverlayLink } from './OverlayLink.tsx'
import { LogIn } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import { NotYet } from './NotYet.tsx'
import { SIGN_UP } from './paths.ts'

export function SignInPage() {
  return (
    <NotYet title="sign in" icon={LogIn}>
      <p className="text-slate-400">
        No account?{' '}
        <OverlayLink
          to={SIGN_UP}
          replace
          className={`text-sky-300 underline-offset-2 hover:underline ${FOCUS_RING}`}
        >
          the same page, in the other direction
        </OverlayLink>
        .
      </p>
    </NotYet>
  )
}
