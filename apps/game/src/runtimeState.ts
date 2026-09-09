import { useSyncExternalStore } from 'react'
import type { DevWorkspace } from './dock/workspace.ts'
import type { GameEngine } from './engine/GameEngine.ts'
import type { HudRenderState } from './hud/controls.ts'

/** The browser's live session handles. No engine module enters the server graph. */
export interface RuntimeSnapshot {
  readonly engine: GameEngine
  readonly dev: DevWorkspace
  readonly render: HudRenderState
  readonly onNotice: (message: string) => void
}

let snapshot: RuntimeSnapshot | null = null
const listeners = new Set<() => void>()
const getSnapshot = (): RuntimeSnapshot | null => snapshot
// Hydration and each server request start from the same engine-free shell.
const getServerSnapshot = (): null => null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Publish when the runtime's UI handles change, never from the frame loop. */
export function publishRuntime(next: RuntimeSnapshot | null): void {
  if (snapshot === next) return
  snapshot = next
  for (const listener of listeners) listener()
}

export function useRuntime(): RuntimeSnapshot | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
