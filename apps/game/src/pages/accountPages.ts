/*
 * What each account page says about itself, beside the Clerk component that
 * does the work. A constant in its own module, so `AccountPage.tsx` exports
 * nothing but the component and Fast Refresh keeps working on it.
 */

export type AccountPageId = 'sign-in' | 'sign-up' | 'profile'

export const ACCOUNT_PAGE: Readonly<
  Record<AccountPageId, { readonly title: string; readonly lead: string }>
> = {
  'sign-in': {
    title: 'Sign in',
    lead: 'Optional. The sky, the catalog and the camera need no account.',
  },
  'sign-up': {
    title: 'Create an account',
    lead: 'Optional. The game is complete without one; an account is what the server can attribute things to.',
  },
  profile: {
    title: 'Your account',
    lead: 'Who this browser is signed in as, and whether the server agrees.',
  },
}

/** What signing in will eventually buy, from `docs/design/modes.md`. */
export const WHAT_AN_ACCOUNT_IS_FOR: readonly string[] = [
  'discovery credit checked against everyone else’s, and attributed publicly',
  'the Almanac and your bookmarks, synced across devices',
  'catalog revisions delivered as they are published',
]
