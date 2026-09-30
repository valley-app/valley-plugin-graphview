import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { getGraphIndex, type GraphIndex } from './indexOwner'

/**
 * Module-global handles to the host's React instance and plugin API, set once in
 * `register(api)` before any view renders — same pattern as the SideNotes plugin.
 * Components import these instead of bundling their own `react`. JSX compiles to
 * `React.createElement` (classic transform), resolving to this binding.
 */
export let React!: typeof import('react')
export let api!: ValleyPluginApi
let index: GraphIndex | undefined

export function initRuntime(a: ValleyPluginApi): void {
  const next = getGraphIndex(a)
  if (index !== next) { void index?.dispose().catch(() => {}); index = next }
  api = a
  React = a.React
}
