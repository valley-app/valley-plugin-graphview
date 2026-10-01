import { assertCommandOutput } from './commandContracts'
import { expect, it, vi } from 'vitest'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { register } from '../src/backend'

it('describes only registered graph data, deduplicating local and qualified datasets', async () => {
  const handle = vi.fn<PluginBackendApi['rpc']['handle']>(() => () => {}), handleOperation = vi.fn<PluginBackendApi['rpc']['handleOperation']>(() => () => {})
  const api = {
    rpc: { handle, handleOperation },
    plugins: { list: async () => [
      {
        id: 'fieldwork', name: 'Fieldwork', version: '1.0.0', enabled: true,
        description: 'General plugin description',
        datasets: [{ id: 'observations', title: 'Observations' }],
        noteDocuments: [
          { dataset: 'observations', sourcePathColumn: 'path' },
          { dataset: 'fieldwork.observations' },
          { dataset: 'archive', label: 'Archive notes' }
        ]
      },
      { id: 'fallback', name: 'Fallback', version: '1.0.0', enabled: true, noteDocuments: [{ dataset: 'notes' }] },
      { id: 'disabled', enabled: false, noteDocuments: [{ dataset: 'notes' }] },
      { id: 'failed', enabled: true, error: 'Unavailable', noteDocuments: [{ dataset: 'notes' }] },
      { id: 'unregistered', enabled: true }
    ] }
  } as unknown as PluginBackendApi
  const dispose = register(api)
  expect(handleOperation.mock.calls[0][0]).toBe('command.sourcePlugins')
  expect(await handleOperation.mock.calls[0][1]({}, { api: { plugins: { list: async () => [] } } } as unknown as PluginBackendOperationContext)).toEqual([])
  expect(handle.mock.calls[0][0]).toBe('sourcePlugins')
  expect(assertCommandOutput('command.sourcePlugins', {}, await handle.mock.calls[0][1]({}))).toEqual([
    { id: 'fieldwork', name: 'Fieldwork', version: '1.0.0', author: [], nodeTypes: ['Observations', 'Archive notes'], linksSourceFiles: true },
    { id: 'fallback', name: 'Fallback', version: '1.0.0', author: [], nodeTypes: ['Fallback'], linksSourceFiles: false }
  ])
  dispose()
})
