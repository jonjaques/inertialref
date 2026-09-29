import { UserRound } from 'lucide-react'
import { AccountDialog } from '../account/AccountDialog.tsx'
import { useAccounts } from '../account/accounts.ts'
import { NotYet } from './NotYet.tsx'

export function ProfilePage() {
  const accounts = useAccounts()
  if (accounts) return <AccountDialog page="profile" />
  return (
    <NotYet title="profile" icon={UserRound}>
      <p className="text-slate-400">
        Your discoveries are recorded in this browser, and a save is under 700
        bytes — the Almanac has somewhere to sync *from* wherever accounts are
        offered.
      </p>
    </NotYet>
  )
}
