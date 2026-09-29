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
  returnAddress,
  SIGNED_OUT_LANDING,
} from './accounts.ts'

const at = (pathname: string, extra: Partial<Location> = {}): Location => ({
  pathname,
  search: '',
  hash: '',
  state: null,
  key: pathname,
  ...extra,
})

/** The planetarium, looking at Mars — the mode every dialog below is over. */
const MODE = at('/planetarium', { search: '?at=s:SOL/b:4' })
const over = (pathname: string, hash = ''): Location =>
  at(pathname, { hash, state: overlayState(MODE) })

describe('accountNavigation', () => {
  it('opens an account dialog over the running mode', () => {
    const next = accountNavigation(SIGN_IN, MODE, false)
    expect(next).toEqual({
      to: SIGN_IN,
      replace: false,
      state: overlayState(MODE),
    })
  })

  it('keeps the mode, not the dialog, as the background from one page to the next', () => {
    // Clerk's "no account? sign up" link, followed from inside the sign-in
    // dialog. Carrying the dialog's own location would make it the background
    // and unmount the planetarium.
    for (const to of [
      SIGN_UP,
      `${SIGN_IN}#/factor-one`,
      `${PROFILE}#/security`,
    ])
      expect(accountNavigation(to, over(SIGN_IN), false).state).toEqual(
        overlayState(MODE),
      )
  })

  it('treats a finished flow as a plain navigation, which closes the dialog', () => {
    // Signing in returns to the address the dialog was opened over.
    const back = returnAddress(over(SIGN_IN))
    expect(back).toBe('/planetarium?at=s:SOL/b:4')
    expect(accountNavigation(back, over(SIGN_IN), false)).toEqual({
      to: back,
      replace: false,
    })
  })

  it('lands a sign-out where the reader is, not on the menu', () => {
    // From the profile dialog, back to the mode behind it.
    expect(accountNavigation(SIGNED_OUT_LANDING, over(PROFILE), false)).toEqual(
      {
        to: '/planetarium?at=s:SOL/b:4',
        replace: true,
      },
    )
    // From the badge in the bar, nowhere at all.
    expect(accountNavigation(SIGNED_OUT_LANDING, MODE, false).to).toBe(
      '/planetarium?at=s:SOL/b:4',
    )
  })

  it('sends a cold-loaded account page home, since it has nothing behind it', () => {
    // A profile shown to nobody is the alternative.
    expect(accountNavigation(SIGNED_OUT_LANDING, at(PROFILE), false).to).toBe(
      HOME,
    )
    expect(returnAddress(at(SIGN_IN))).toBe(HOME)
  })

  it('carries no background on from a dialog that was loaded cold', () => {
    // Nothing is behind `/sign-in` opened from a link; naming it as the
    // background of `/sign-up` would make closing one open the other.
    expect(accountNavigation(SIGN_UP, at(SIGN_IN), true)).toEqual({
      to: SIGN_UP,
      replace: true,
    })
  })

  it('leaves an ordinary address alone', () => {
    // The menu itself is not the sign-out marker without its query.
    expect(accountNavigation(HOME, MODE, true)).toEqual({
      to: HOME,
      replace: true,
    })
    expect(accountNavigation(SETTINGS, over(PROFILE), false).state).toEqual(
      overlayState(MODE),
    )
  })
})
