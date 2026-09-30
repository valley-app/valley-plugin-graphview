import { afterEach, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { PLUGIN_SURFACE_V1, type PluginIndexPage } from '@valley/plugin-sdk'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { register } from '../src/index'
import { getGraphIndex } from '../src/indexOwner'
import { useIndexEntries, useNoteDocuments } from '../src/useGraph'

const entry = (index: number) => ({ relPath: `Grove/${index}.md`, title: `Grove ${index}`, kind: 'note' as const, mtimeMs: index, ctimeMs: 1, tags: ['trees'], aliases: [`Tree ${index}`], links: ['tree 0'], frontmatter: { secret: 'not requested' } })
const cleanups: (() => unknown)[] = []
const releases: (() => void)[] = []
afterEach(async () => { for (const release of releases.splice(0)) release(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

function hold(mock: ReturnType<typeof createMockValleyApi>, offset: number) {
  const observe = mock.api.index.observe
  let captured: PluginIndexPage | undefined
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  const disposed = vi.fn()
  vi.spyOn(mock.api.index, 'observe').mockImplementation(async (scope, listener) => {
    const owner = await observe(scope, listener)
    return { read: async request => {
      const page = await owner.read(request)
      if (request?.offset === offset && !captured) { captured = page; await gate }
      return page
    }, dispose: async () => { disposed(); await owner.dispose() } }
  })
  return { release, captured: () => captured, disposed }
}

it('shares complete scoped pages between views, focus commands and surface restore', async () => {
  const mock = createMockValleyApi({ manifest: { id: 'graphView', indexState: 'scoped' }, indexEntries: Array.from({ length: 129 }, (_, index) => entry(index)) })
  const held = hold(mock, 128)
  cleanups.push(register(mock.api))
  const view = renderHook(() => [useIndexEntries(), useIndexEntries()])
  cleanups.push(view.unmount)
  await waitFor(() => expect(held.captured()).toBeDefined())
  const focusing = mock.api.commands.execute('graphView:focus', { path: 'Grove/128.md' })
  const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
  const restoring = surface.restore!({ centerId: 'Grove/128.md' })
  const settled = vi.fn()
  void Promise.all([focusing, restoring]).then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  expect(view.result.current).toEqual([[], []])
  expect(mock.api.getState().indexEntries).toEqual([])
  await act(async () => { held.release(); await restoring; await focusing })
  expect(view.result.current[0]).toHaveLength(129)
  expect(view.result.current[0]).toBe(view.result.current[1])
  expect(view.result.current[0][0]).not.toHaveProperty('frontmatter')
  expect(surface.getSnapshot().item?.title).toBe('Grove 128')
  expect(mock.api.index.observe).toHaveBeenCalledOnce()
  expect(mock.api.index.observe).toHaveBeenCalledWith({ fields: ['aliases', 'ctimeMs', 'kind', 'links', 'mtimeMs', 'tags', 'title'] }, expect.any(Function))
})

it('resynchronizes skipped index revisions without taking full renderer state', async () => {
  const mock = createMockValleyApi({ manifest: { id: 'graphView', indexState: 'scoped' }, indexEntries: [entry(0)] })
  const observe = mock.api.index.observe
  let skip = true
  vi.spyOn(mock.api.index, 'observe').mockImplementation((scope, listener) => observe(scope, change => { if (skip) { skip = false; return }; listener(change) }))
  cleanups.push(register(mock.api))
  const index = getGraphIndex(mock.api)
  await index.ready()
  const before = index.entries()
  mock.emitState({ indexEntries: [entry(1)] })
  expect(index.entries()).toBe(before)
  mock.emitState({ indexEntries: [entry(1), entry(2)] })
  await waitFor(() => expect(index.entries().map(value => value.relPath)).toEqual(['Grove/1.md', 'Grove/2.md']))
  expect(mock.api.getState().indexEntries).toEqual([])
})

it('resolves fence targets by filename, title and alias from owned pages', async () => {
  const mock = createMockValleyApi({ manifest: { id: 'graphView', indexState: 'scoped' }, indexEntries: [entry(0)] })
  vi.spyOn(mock.api.workspace, 'resolveWikilink').mockImplementation(() => { throw new Error('Legacy index resolver is unavailable') })
  cleanups.push(register(mock.api))
  const owner = getGraphIndex(mock.api)
  await owner.ready()
  for (const ref of ['0.md', '0', 'Grove 0', 'Tree 0', 'Grove/0.md']) expect(owner.resolve(ref)).toBe('Grove/0.md')
  expect(owner.resolve('missing')).toBeNull()
  expect(mock.api.getState().indexEntries).toEqual([])
})

it('joins held reads and releases once without publishing after vault revocation', async () => {
  const mock = createMockValleyApi({ manifest: { id: 'graphView', indexState: 'scoped' }, indexEntries: [entry(0)] })
  const held = hold(mock, 0)
  const dispose = register(mock.api)
  cleanups.push(dispose)
  const index = getGraphIndex(mock.api)
  const readiness = expect(index.ready()).rejects.toThrow('no longer active')
  await waitFor(() => expect(held.captured()).toBeDefined())
  const changed = vi.fn()
  index.subscribe(changed)
  const root = mock.api.getState().vault
  mock.emitState({ vault: { path: '/mock/other', name: 'other', displayName: 'other' } })
  mock.emitState({ vault: root })
  const ended = vi.fn()
  const closing = dispose()
  expect(dispose()).toBe(closing)
  void closing.then(ended)
  await readiness
  expect(ended).not.toHaveBeenCalled()
  held.release(); await closing
  expect(held.disposed).toHaveBeenCalledOnce()
  expect(changed).not.toHaveBeenCalled()
  expect(index.entries()).toEqual([])
})

it('shares document paging between views and physically joins its accepted page on disposal', async () => {
  const mock = createMockValleyApi({ manifest: { id: 'graphView', indexState: 'scoped' } })
  const dispose = register(mock.api)
  cleanups.push(dispose)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  const query = vi.spyOn(mock.api.documents, 'query').mockImplementation(async () => { await held; return { documents: [], cursor: 'next' } })
  const first = renderHook(useNoteDocuments)
  const second = renderHook(useNoteDocuments)
  cleanups.push(first.unmount, second.unmount)
  await waitFor(() => expect(query).toHaveBeenCalledOnce())
  const closed = vi.fn()
  const draining = dispose().then(closed)
  await Promise.resolve()
  expect(closed).not.toHaveBeenCalled()
  await act(async () => { release(); await draining })
  expect(query).toHaveBeenCalledOnce()
  expect(first.result.current).toBe(second.result.current)
  expect(first.result.current.documents).toEqual([])
})

it('joins every accepted document refresh after a sibling read rejects', async () => {
  const mock = createMockValleyApi({ manifest: { id: 'graphView', indexState: 'scoped' } })
  let changed!: Parameters<typeof mock.api.documents.onChanged>[0]
  vi.spyOn(mock.api.documents, 'onChanged').mockImplementation(listener => { changed = listener; return () => {} })
  const query = vi.spyOn(mock.api.documents, 'query')
  const dispose = register(mock.api)
  cleanups.push(dispose)
  const view = renderHook(useNoteDocuments)
  cleanups.push(view.unmount)
  await waitFor(() => expect(query).toHaveBeenCalledOnce())
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  const read = vi.spyOn(mock.api.documents, 'read')
    .mockRejectedValueOnce(new Error('first read failed'))
    .mockImplementationOnce(async () => { await held; return null })
  changed({ vaultGeneration: 1, reason: 'commit', refs: [
    { pluginId: 'journal', sourceId: 'notes', itemId: 'first' },
    { pluginId: 'journal', sourceId: 'notes', itemId: 'second' }
  ] })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  const closed = vi.fn()
  const draining = dispose().then(closed)
  await Promise.resolve()
  expect(closed).not.toHaveBeenCalled()
  await act(async () => { release(); await draining })
  expect(closed).toHaveBeenCalledOnce()
  expect(view.result.current.error).toBe('')
})
