import { UserRound } from 'lucide-react'
import { NotYet } from './NotYet.tsx'

export function ProfilePage() {
  return (
    <NotYet title="profile" icon={UserRound}>
      <p className="text-slate-400">
        Your discoveries are recorded locally in the meantime, and a save is
        under 700 bytes — the Almanac has somewhere to sync *from* whenever this
        is built.
      </p>
    </NotYet>
  )
}
