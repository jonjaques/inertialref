import { OverlayLink } from './OverlayLink.tsx'
import { UserRoundPlus } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import { NotYet } from './NotYet.tsx'
import { SIGN_IN } from './paths.ts'

export function SignUpPage() {
  return (
    <NotYet title="sign up" icon={UserRoundPlus}>
      <p className="text-slate-400">
        Already have one?{' '}
        <OverlayLink
          to={SIGN_IN}
          replace
          className={`text-sky-300 underline-offset-2 hover:underline ${FOCUS_RING}`}
        >
          sign in
        </OverlayLink>
        .
      </p>
    </NotYet>
  )
}
