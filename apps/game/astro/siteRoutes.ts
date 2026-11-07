import { CUTSCENES } from '@inertialref/devtools'
import {
  ABOUT,
  AUTH_CALLBACK,
  CATALOG,
  CINEMA,
  CREDITS,
  HOME,
  KEYS,
  PLANETARIUM,
  PLAY_MULTIPLAYER,
  PLAY_ONLINE,
  PLAY_SOLO,
  PRESETS,
  PROFILE,
  SETTINGS,
  SIGN_IN,
  SIGN_UP,
  cinemaScene,
  settingsSection,
} from '../src/pages/paths.ts'

/** Cold visits render the same route set the persistent client router accepts. */
export const shellPaths = [
  HOME,
  ABOUT,
  AUTH_CALLBACK,
  CATALOG,
  CINEMA,
  CREDITS,
  KEYS,
  PLANETARIUM,
  PLAY_MULTIPLAYER,
  PLAY_ONLINE,
  PLAY_SOLO,
  PRESETS,
  PROFILE,
  SETTINGS,
  SIGN_IN,
  SIGN_UP,
  /*
   * Every section the settings page draws a tab for, and `camera` besides,
   * which is not a section and which links in the wild still name: it opens
   * the display page. A section with no file here is the Worker's 404 page on
   * a cold visit, not the fallback `SettingsPage` gives an unknown section.
   */
  ...[
    'display',
    'audio',
    'interface',
    'controls',
    'controller',
    'data',
    'camera',
  ].map(settingsSection),
  ...CUTSCENES.map((script) => cinemaScene(script.id)),
]
