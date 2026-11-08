/**
 * Graph View — a knowledge graph rendered entirely from the scoped realm index.
 * Three views:
 *   - `graphView.global`    (left_sidebar): the row naming the active saved
 *     graph, then the Filters / Color groups / Display controls — one section
 *     at a time behind an icon-chip strip. Graphs save themselves via
 *     `api.settings`.
 *   - `graphView.globalTab` (main_workspace): the graph itself under a title bar
 *     with a separate Find row and legend. Counts live in footer details;
 *     its settings live in the sidebar panel, which shares one store.
 *   - `graphView.local`     (right_sidebar): the neighborhood of the active file,
 *     with its own independently saved config + saved graphs.
 */
import type { ValleyPluginApi, ValleyPluginModule } from '@valley/plugin-sdk'
import { initRuntime } from './runtime'
import { injectStyles } from './styles'
import { registerGraphFence } from './fence'
import { registerGraphCommands } from './commands'
import { GraphSourceSettings } from './GraphControls'
import { GlobalGraph, GlobalGraphTab } from './GlobalGraph'
import { LocalGraph } from './LocalGraph'
import { initLocalization } from './localization'
import { registerGraphSurfaces } from './surfaces'
import { getGraphIndex } from './indexOwner'

export function register(api: ValleyPluginApi): () => Promise<void> {
  initLocalization(api)
  initRuntime(api)
  const index = getGraphIndex(api)
  let disposal: Promise<void> | undefined
  const disposeStyles = injectStyles()

  api.registerView('graphView.settings', GraphSourceSettings)
  api.registerView('graphView.global', GlobalGraph)
  api.registerView('graphView.globalTab', GlobalGraphTab)
  api.registerView('graphView.local', LocalGraph)

  const offFence = registerGraphFence()
  const offCommands = registerGraphCommands(api)
  const offSurfaces = registerGraphSurfaces(api)

  return () => {
    if (disposal) return disposal
    offFence()
    offCommands()
    offSurfaces()
    disposeStyles()
    return disposal = index.dispose()
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
