import { ENTERPRISE_PORTRAITS } from './enterprisePortraits.ts'
import { MARS_LANDING } from './marsLanding.ts'
import { TNG_INTRO } from './tngIntro.ts'

/** The director and document host publish the same scene library. */
export const CUTSCENES = [
  TNG_INTRO,
  ENTERPRISE_PORTRAITS,
  MARS_LANDING,
] as const
