import type { Location } from 'react-router'

/*
 * The route table, as data.
 *
 * Its own module for the same reason `hud/tabs.ts` is: four kinds of file need
 * these strings for different reasons — the route table declares them, links
 * point at them, the shell derives a *mode* from them, and tests assert on
 * them — and a `routes.tsx` that exported both a constant and a component is a
 * file Fast Refresh gives up on.
 *
 * **The URL is the product's public surface.** Everything a person might want
 * to send someone — a mode, a scene at a frame, a body in the planetarium, a
 * settings section — is addressable, and nothing that is addressable is
 * reachable only by clicking. That is a decision rather than a convenience:
 * ADR-0011 has the argument, and the short version is that a game which is a
 * link has to behave like one.
 */

/* ------------------------------------------------------------------------- */
/* Paths                                                                      */
/* ------------------------------------------------------------------------- */

/** The menu. A live scene with a mode chooser over it — never a blank page. */
export const HOME = '/'

/** Solo offline: the flight simulation, complete, with no network of any kind. */
export const PLAY_SOLO = '/play/solo'

/** Solo online: the same game, connected, with discovery credit and sync. */
export const PLAY_ONLINE = '/play/online'

/** The persistent universe. Deferred — ADR-0008 and `docs/design/modes.md`. */
export const PLAY_MULTIPLAYER = '/play/multiplayer'

/** Free navigation of the galaxy. No ship, no fuel, nowhere you cannot go. */
export const PLANETARIUM = '/planetarium'

/** The scene library. */
export const CINEMA = '/cinema'

/** One scene, in the player. `/cinema/tng-intro?t=1150&play=1`. */
export const cinemaScene = (id: string): string =>
  `${CINEMA}/${encodeURIComponent(id)}`

/** Settings, over whatever is running. */
export const SETTINGS = '/settings'
export const settingsSection = (section: string): string =>
  `${SETTINGS}/${section}`

/** What this is, and who made it. */
export const ABOUT = '/about'

/** The account routes. Stubs today — the seam, not the feature. */
export const SIGN_IN = '/sign-in'
export const SIGN_UP = '/sign-up'
export const PROFILE = '/profile'
/**
 * Where an identity provider comes back to.
 *
 * Its own path rather than a query parameter on `/`, because a redirect URI is
 * registered with the provider ahead of time and changing it later is a
 * coordinated deploy. Reserving it now costs a route and saves that.
 */
export const AUTH_CALLBACK = '/auth/callback'

/* ------------------------------------------------------------------------- */
/* Modes                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * What the engine is *doing*, which is not the same as what is on screen.
 *
 * Four values, and each one is a different answer to "who owns the camera":
 *
 * | mode          | camera            | ship drawn | chrome                    |
 * | ------------- | ----------------- | ---------- | ------------------------- |
 * | `menu`        | the opening shot  | no         | the mode chooser          |
 * | `flight`      | chase, from the ship | yes     | the cockpit strip         |
 * | `planetarium` | the observatory   | no         | dockable panels           |
 * | `cinema`      | the cutscene director | script | transport                 |
 *
 * A mode is derived from the path rather than held in state, so a reload, a
 * back button and a pasted link all land in the same place. The derivation is
 * a pure function precisely so that claim is testable without a browser.
 */
export const MODES = ['menu', 'flight', 'planetarium', 'cinema'] as const
export type AppMode = (typeof MODES)[number]

/**
 * The mode a path runs in.
 *
 * Overlay routes — settings, about, the account pages — deliberately answer
 * `menu`. They are dialogs and can be opened over any mode, and when one is
 * opened from inside a mode the router carries the mode's location as the
 * background (see `routes.tsx`), so this is only consulted for a *cold* load.
 * Cold-loading `/settings` over the menu is the honest answer: there is no
 * session behind it yet.
 */
export function modeForPath(pathname: string): AppMode {
  if (pathname === PLANETARIUM || pathname.startsWith(`${PLANETARIUM}/`))
    return 'planetarium'
  if (pathname === CINEMA || pathname.startsWith(`${CINEMA}/`)) return 'cinema'
  if (pathname.startsWith('/play/')) return 'flight'
  return 'menu'
}

/** Whether a path is a dialog that opens over a mode rather than replacing it. */
export function isOverlayPath(pathname: string): boolean {
  return (
    pathname === SETTINGS ||
    pathname.startsWith(`${SETTINGS}/`) ||
    pathname === ABOUT ||
    pathname === PROFILE ||
    pathname === SIGN_IN ||
    pathname === SIGN_UP ||
    pathname === AUTH_CALLBACK
  )
}

/* ------------------------------------------------------------------------- */
/* Opening a dialog over a mode                                               */
/* ------------------------------------------------------------------------- */

/**
 * What a `Link` puts in `location.state` to keep a mode on screen behind a
 * dialog.
 *
 * The standard React Router modal pattern, and the alternative is worse than it
 * looks: without it, opening settings from the planetarium unmounts the
 * planetarium — which drops the observatory's target, hands the camera back to
 * the ship, and tears down a dock layout mid-drag. The dialog would be correct
 * and the thing behind it would have quietly reset.
 *
 * Here rather than in `routes.tsx` so that file exports components and nothing
 * else, which is what keeps Fast Refresh able to reload it.
 */
export interface OverlayLocationState {
  readonly background?: Location
}

export const overlayState = (location: Location): OverlayLocationState => ({
  background: location,
})

/* ------------------------------------------------------------------------- */
/* Search parameters                                                          */
/* ------------------------------------------------------------------------- */

/**
 * The query keys, named once.
 *
 * They are part of the URL contract — a cinema link carries `t` and `play`,
 * a planetarium link carries `at` — and a typo in one of the three files that
 * reads them is a link that silently loses half its meaning.
 */
export const QUERY = {
  /** Cinema: the frame to open at. Frames rather than seconds — see ADR-0010. */
  frame: 't',
  /** Cinema: `1` to start running rather than parked on the frame. */
  autoplay: 'play',
  /** Planetarium: the address the observatory opens on. */
  at: 'at',
  /** Every mode: the world seed, which `GameEngine` already reads. */
  seed: 'seed',
} as const

/**
 * A cinema link, with everything it needs to reproduce the frame on screen.
 *
 * `frame` is floored: the director's playhead is fractional between rendered
 * frames, and a link that carried `1150.3187` would claim a precision the
 * reference edit does not have.
 */
export function cinemaLink(
  id: string,
  options: { frame?: number; autoplay?: boolean } = {},
): string {
  const query = new URLSearchParams()
  if (options.frame !== undefined && options.frame > 0)
    query.set(QUERY.frame, String(Math.floor(options.frame)))
  if (options.autoplay === true) query.set(QUERY.autoplay, '1')
  const suffix = query.toString()
  return suffix.length === 0 ? cinemaScene(id) : `${cinemaScene(id)}?${suffix}`
}

/** A planetarium link that opens on a given address. */
export function planetariumLink(address?: string): string {
  return address === undefined || address.length === 0
    ? PLANETARIUM
    : `${PLANETARIUM}?${QUERY.at}=${encodeURIComponent(address)}`
}
