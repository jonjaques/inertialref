import { Link } from 'react-router'
import { LogIn } from 'lucide-react'
import { FOCUS_RING } from '../hud/focus.ts'
import { NotYet } from './NotYet.tsx'
import { SIGN_UP } from './paths.ts'
import { useOverlay } from './useOverlay.ts'

export function SignInPage() {
  // The cross-link stays inside the dialog, so it carries the mode behind it —
  // see `useOverlay`. Without the state it takes the mode down with it.
  const { keep } = useOverlay()
  return (
    <NotYet title="sign in" icon={LogIn}>
      <p className="text-slate-400">
        No account?{' '}
        <Link
          to={SIGN_UP}
          state={keep}
          replace
          className={`text-sky-300 underline-offset-2 hover:underline ${FOCUS_RING}`}
        >
          the same page, in the other direction
        </Link>
        .
      </p>
    </NotYet>
  )
}
