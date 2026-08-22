import { useParams } from 'react-router'
import type { GameEngine } from '../engine/GameEngine.ts'
import { CinemaLibrary } from './CinemaLibrary.tsx'
import { CinemaPlayer } from './CinemaPlayer.tsx'

/**
 * `/cinema` is a library and `/cinema/:scene` is a player.
 *
 * One route entry with a branch rather than two components wired separately,
 * because the two share nothing but the path prefix — and the branch is the
 * cheapest place to say which of them a URL means.
 */
export function CinemaMode({ engine }: { engine: GameEngine }) {
  const { scene } = useParams<{ scene?: string }>()
  return scene === undefined ? (
    <CinemaLibrary engine={engine} />
  ) : (
    <CinemaPlayer engine={engine} id={scene} />
  )
}
