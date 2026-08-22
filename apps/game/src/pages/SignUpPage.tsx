import { Link } from 'react-router'
import { UserRoundPlus } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import { NotYet } from './NotYet.tsx'
import { SIGN_IN } from './paths.ts'
import { useOverlay } from './useOverlay.ts'

export function SignUpPage() {
  const { keep } = useOverlay()
  return (
    <NotYet title="sign up" icon={UserRoundPlus}>
      <p className="text-slate-400">
        Already have one?{' '}
        <Link
          to={SIGN_IN}
          state={keep}
          replace
          className={`text-sky-300 underline-offset-2 hover:underline ${FOCUS_RING}`}
        >
          sign in
        </Link>
        .
      </p>
    </NotYet>
  )
}
