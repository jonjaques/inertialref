import type { Location } from 'react-router'
import { describe, expect, it } from 'vitest'
import {
  HOME,
  overlayState,
  PROFILE,
  SETTINGS,
  SIGN_IN,
  SIGN_UP,
} from '../pages/paths.ts'
import {
  accountNavigation,
  isAccountPath,
  returnAddress,
  SIGNED_OUT_LANDING,
  usablePublishableKey,
} from './accounts.ts'

const at = (pathname: string, extra: Partial<Location> = {}): Location => ({
  pathname,
  search: '',
  hash: '',
  state: null,
  key: pathname,
  ...extra,
})

/** The planetarium, looking at Mars. */
const MODE = at('/planetarium', { search: '?at=s:SOL/b:4' })

describe('accountNavigation', () => {
  it('resolves a bare fragment against the page it was asked from', () => {
    // The profile's own sections. Resolved against the root, this was the
    // menu — the jump from the profile to the home page.
    expect(accountNavigation('#/security', at(PROFILE), false)).toEqual({
      to: `${PROFILE}#/security`,
      replace: false,
    })
    expect(
      accountNavigation('#/factor-one', at(SIGN_IN, { hash: '#/' }), true),
    ).toEqual({ to: `${SIGN_IN}#/factor-one`, replace: true })
  })

  it('goes from one account page to the next', () => {
    expect(accountNavigation(SIGN_UP, at(SIGN_IN), false)).toEqual({
      to: SIGN_UP,
      replace: false,
    })
  })

  it('stays put when a modal finishes where it was opened', () => {
    expect(
      accountNavigation('/planetarium?at=s:SOL/b:4', MODE, false),
    ).toBeNull()
    expect(
      accountNavigation(
        'http://localhost:5173/planetarium?at=s:SOL/b:4',
        MODE,
        false,
      ),
    ).toBeNull()
  })

  it('lands a sign-out where the reader is, unless that is an account page', () => {
    // From the badge in a mode's bar: nowhere at all.
    expect(accountNavigation(SIGNED_OUT_LANDING, MODE, false)).toBeNull()
    // From the profile page: home, since it has nothing to show.
    expect(accountNavigation(SIGNED_OUT_LANDING, at(PROFILE), false)).toEqual({
      to: HOME,
      replace: true,
    })
    // From under a dialog: back to the mode, which closes the dialog.
    expect(
      accountNavigation(
        SIGNED_OUT_LANDING,
        at(SETTINGS, { state: overlayState(MODE) }),
        false,
      ),
    ).toEqual({ to: '/planetarium?at=s:SOL/b:4', replace: true })
  })

  it('leaves the menu itself alone: it is only the marker with its query', () => {
    expect(accountNavigation(HOME, MODE, false)).toEqual({
      to: HOME,
      replace: false,
    })
    expect(returnAddress(at(SIGN_IN))).toBe(HOME)
  })
})

describe('isAccountPath', () => {
  it('names the three account pages and nothing under them', () => {
    for (const path of [SIGN_IN, SIGN_UP, PROFILE])
      expect(isAccountPath(path)).toBe(true)
    for (const path of [
      HOME,
      SETTINGS,
      `${SIGN_IN}/factor-one`,
      '/auth/callback',
    ])
      expect(isAccountPath(path)).toBe(false)
  })
})

describe('usablePublishableKey', () => {
  it('keeps a key that names an instance', () => {
    const key = `pk_test_${btoa('example-otter-1234.clerk.accounts.dev$')}`
    expect(usablePublishableKey(key)).toBe(key)
    const live = `pk_live_${btoa('clerk.example.test$')}`
    expect(usablePublishableKey(live)).toBe(live)
  })

  it('treats a placeholder or the wrong kind of key as no key', () => {
    for (const key of [
      'pk_live_REPLACE_WITH_PRODUCTION_PUBLISHABLE_KEY',
      `pk_test_${btoa('no-terminator.example')}`,
      'sk_test_abcdef0123456789',
      '',
    ])
      expect(usablePublishableKey(key), key).toBe('')
  })
})
