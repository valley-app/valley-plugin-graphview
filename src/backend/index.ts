import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { GraphSourcePlugin } from '../types'

export function register(api: PluginBackendApi): () => void {
  return api.rpc.handle('sourcePlugins', async (): Promise<GraphSourcePlugin[]> =>
    (await api.plugins.list())
      .filter(plugin => plugin.enabled && !plugin.error && plugin.noteDocuments?.length)
      .map(({ id, name, version, author, noteDocuments = [], datasets = [] }) => ({
        id, name, version, author: author ?? [],
        nodeTypes: [...new Set(noteDocuments.map(source => {
          const datasetId = source.dataset.replace(`${id}.`, '')
          return datasets.find(dataset => dataset.id === datasetId || dataset.id === source.dataset)?.title || source.label || name
        }))],
        linksSourceFiles: noteDocuments.some(source => Boolean(source.sourcePathColumn))
      })))
}
