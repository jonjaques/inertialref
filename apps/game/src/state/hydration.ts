import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}
const client = () => true
const server = () => false

/** Browser preferences become visible after the server markup is hydrated. */
export const useHydrated = (): boolean =>
  useSyncExternalStore(subscribe, client, server)
