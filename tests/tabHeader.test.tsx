import Ajv2020 from 'ajv/dist/2020'
import * as React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi, type MockValleyApi } from '@valley/plugin-testkit'
import type { NoteDocument, UiMenuItem } from '@valley/plugin-sdk'
import { initRuntime } from '../src/runtime'
import { GlobalGraph, GlobalGraphTab } from '../src/GlobalGraph'
import { LocalGraph } from '../src/LocalGraph'
import { GraphControls, GraphSourceSettings } from '../src/GraphControls'
import { GraphTabHeader } from '../src/GraphTabHeader'
import { register as registerGraph } from '../src/index'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1, WORKSPACE_DETAILS_V1 } from '@valley/plugin-sdk'
import { GraphSearch, graphSurfaceActions, registerGraphSurfaces, useGraphSurface } from '../src/surfaces'
import { DEFAULT_CONFIG, GLOBAL_KEYS, LOCAL_KEYS, readActiveGraph, readConfig, readSavedGraphs } from '../src/settings'
import { PresetStore, storeFor } from '../src/presets'
import { useNoteDocuments } from '../src/useGraph'
import { paletteRef } from '@valley/plugin-sdk/palette'

function validatePublishedResults(mock: { api: import('@valley/plugin-sdk').ValleyPluginApi }): void {
  const original = mock.api.commands.register
  vi.spyOn(mock.api.commands, 'register').mockImplementation(definition => {
    const schema = (definition as typeof definition & { outputSchema?: Record<string, unknown> }).outputSchema
    expect(schema, definition.id).toBeDefined()
    const validate = new Ajv2020({ strict: false, strictSchema: true, allowUnionTypes: true, ownProperties: true, validateFormats: false }).compile(schema!)
    expect(validate({ unexpected: true }), definition.id).toBe(false)
    return original({ ...definition, run: async (input, context) => {
      const result = await definition.run(input, context)
      const value = definition.sideEffect === 'write' ? (result as { value: unknown }).value : result
      expect(validate(value), `${definition.id}: ${JSON.stringify(validate.errors)}`).toBe(true)
      return result
    } } as typeof definition)
  })
}

const FOCUS_PATH = 'Fern Canopy.md'

it('releases mounted and provider subscriptions without accessing a revoked session', () => {
  const mock = setup()
  const dispose = registerGraphSurfaces(mock.api)
  const mounted = renderHook(() => useGraphSurface('main_workspace'))
  const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
  const unsubscribe = surface.subscribe(vi.fn())
  const state = mock.api.runtime.getOrCreate('graphView.surfaces', () => ({ listeners: new Set() }))
  expect(state.listeners.size).toBe(2)
  dispose()
  const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => { throw new Error('Plugin session is no longer active') })
  try {
    unsubscribe()
    mounted.unmount()
    expect(state.listeners.size).toBe(0)
    expect(runtime).not.toHaveBeenCalled()
  } finally { runtime.mockRestore(); mounted.unmount() }
})

function setup(): MockValleyApi {
  const mock = createMockValleyApi({
    manifest: { id: 'graphView' },
    vault: { path: '/mock/vault', name: 'mock', displayName: 'mock' },
    indexEntries: [
      { relPath: FOCUS_PATH, title: 'Fern Canopy', kind: 'note', mtimeMs: 0, frontmatter: {} },
      { relPath: 'Shelf Fungus.md', title: 'Shelf Fungus', kind: 'note', mtimeMs: 0, frontmatter: {} }
    ]
  })
  validatePublishedResults(mock)
  initRuntime(mock.api)
  return mock
}

/** Mount the header alone; the ⋯ items it pairs with come from the surface. */
function renderHeader(): void {
  render(
    React.createElement(GraphTabHeader)
  )
}

/** Return the ⋯ menu item carrying `id`. */
function menuItem(_mock: MockValleyApi, id: string, path: string | null = FOCUS_PATH): UiMenuItem {
  const item = graphSurfaceActions(path).find((entry) => entry.id === id)
  if (!item) throw new Error(`no '${id}' item in the actions menu`)
  return item
}

/** Answer the next host menu with `choice` and return the items it offered. */
function pickFromMenu(mock: MockValleyApi, choice: string | null): { items: () => UiMenuItem[] } {
  let offered: UiMenuItem[] = []
  vi.spyOn(mock.api.ui, 'openMenu').mockImplementationOnce(async (items) => {
    offered = items as UiMenuItem[]
    return choice
  })
  return { items: () => offered }
}

afterEach(cleanup)

describe('graph tab header', () => {
  it('leaves navigation and the ⋯ menu to the host and search to Properties', async () => {
    setup()
    await act(async () => { render(React.createElement(GlobalGraphTab)) })

    expect(screen.queryByTitle('Back')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Forward')).not.toBeInTheDocument()
    expect(screen.queryByTitle('More actions')).toBeNull()
    expect(screen.queryByTitle('Saved graphs')).toBeNull()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('keeps the selected graph name in the workspace header as it changes', async () => {
    const mock = setup()
    await mock.api.settings.set('savedGraphs', [{ name: 'Habitats' }])
    await mock.api.settings.set('activeGraph', 'Habitats')
    const { container } = render(React.createElement(GlobalGraphTab))
    await act(async () => {})

    const title = container.querySelector('.graphview-topbar-title')
    expect(title?.textContent).toBe('Habitats')
    await act(async () => { storeFor(GLOBAL_KEYS).renameActive('Wetlands') })
    expect(title?.textContent).toBe('Wetlands')
    await act(async () => { storeFor(GLOBAL_KEYS).select('') })
    expect(title?.textContent).toBe('Default graph')
    await act(async () => { storeFor(GLOBAL_KEYS).select('Wetlands') })
    expect(title?.textContent).toBe('Wetlands')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(container.querySelector('.graphview-searchbar')).toBeNull()
    expect(title?.querySelector('button')).toBeNull()
    expect(container.querySelector('.graphview-topbar-actions button')).toBeNull()
  })

  it('highlights matches, steps through them and clears on Escape', async () => {
    setup()
    const state = renderHook(() => useGraphSurface('main_workspace'))
    const { container } = render(React.createElement(React.Fragment, null, React.createElement(GlobalGraphTab), React.createElement(GraphSearch)))
    expect(container.querySelector('.graphview-stats')).toBeNull()
    const find = screen.getByRole('searchbox', { name: 'Find in graph' })

    fireEvent.change(find, { target: { value: 'fungus' } })
    await waitFor(() => expect(container.querySelector('.graphview-find-count')?.textContent).toBe('1'))
    fireEvent.keyDown(find, { key: 'Enter' })
    expect(container.querySelector('.graphview-find-count')?.textContent).toBe('1/1')
    expect(state.result.current.focusId).toBe('Shelf Fungus.md')
    const run = state.result.current.focusRun
    fireEvent.click(screen.getByRole('button', { name: 'Shelf Fungus Shelf Fungus.md' }))
    expect(state.result.current.focusRun).toBe(run + 1)

    fireEvent.change(find, { target: { value: 'nothing' } })
    await waitFor(() => expect(container.querySelector('.graphview-find-count')?.textContent).toBe('0'))
    expect(container.querySelector('.graphview-find-count')?.getAttribute('title')).toBe('No matches')

    fireEvent.keyDown(find, { key: 'Escape' })
    expect(find).toHaveValue('')
    expect(container.querySelector('.graphview-find-count')).toBeNull()
  })

  it('explains colors in a legend that Display can hide', async () => {
    setup()
    const store = storeFor(GLOBAL_KEYS)
    store.apply({ ...store.get().config, display: { ...store.get().config.display, showLegend: true } })
    const { container } = render(React.createElement(GlobalGraphTab))
    await waitFor(() => expect(screen.getByRole('list', { name: 'Legend' }).textContent).toBe('Orphans'))
    act(() => {
      const store = storeFor(GLOBAL_KEYS)
      store.apply({ ...store.get().config, display: { ...store.get().config.display, showLegend: false } })
    })
    expect(container.querySelector('.graphview-legend')).toBeNull()
  })

  it('publishes live footer counts and a plain Info breakdown with first-match group priority', async () => {
    const mock = setup()
    const dispose = registerGraphSurfaces(mock.api)
    const details = mock.api.interop.extensions.providers(WORKSPACE_DETAILS_V1)[0].extension
    const info = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1).find(({ extension }) => extension.id === 'graphView.info')!.extension
    const context = { relPath: '', kind: 'unsupported' as const }
    const footerContext = { selectedItemIds: ['nodes', 'links'] }
    const changed = vi.fn()
    const unsubscribe = details.subscribe(changed)
    try {
      expect(info.icon).toBe('info')
      const search = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1).find(({ extension }) => extension.id === 'graphView.properties')!.extension
      expect(search).toMatchObject({ label: 'Search', icon: 'search' })
      expect(details.defaultItems).toEqual(['nodes', 'links'])
      expect(details.items.map((item) => item.id)).toEqual(['nodes', 'links', 'name', 'groups'])
      await waitFor(() => expect(details.getSnapshot(footerContext).items.nodes.text).toBe('Nodes: 2'))
      const store = storeFor(GLOBAL_KEYS)
      act(() => {
        store.apply({ ...store.get().config, colorGroups: [
          { id: 'first', query: 'Fern', color: paletteRef('teal') },
          { id: 'second', query: 'path:.md', color: paletteRef('blue') },
          { id: 'empty', query: '  ', color: paletteRef('blue') }
        ] })
        store.renameActive('Habitats')
      })
      expect(changed).toHaveBeenCalled()
      expect(details.getSnapshot(footerContext).items).toMatchObject({ nodes: { text: 'Nodes: 2' }, links: { text: 'Links: 0' }, name: { text: 'Habitats' }, groups: { text: 'Groups: 2' } })
      const fields = await info.inspect!(context)
      expect(fields.every((field) => field.readOnly && typeof field.value !== 'object')).toBe(true)
      expect(fields.filter((field) => field.id.startsWith('group:')).map((field) => [field.label, field.value])).toEqual([['Fern', 1], ['path:.md', 1]])
      const { container, unmount } = render(React.createElement(React.Fragment, null, info.render(context)))
      expect(screen.getByText('Filter breakdown')).toBeInTheDocument()
      expect(container.querySelectorAll('input, textarea, select')).toHaveLength(0)
      act(() => store.apply({ ...store.get().config, filters: { ...store.get().config.filters, rules: [{ id: 'base', query: 'missing', exclude: false }] } }))
      expect(details.getSnapshot(footerContext).items.nodes.text).toBe('Nodes: 0')
      expect(details.getSnapshot(footerContext).items.links.text).toBe('Links: 0')
      expect(container.querySelector('.props-info-row:nth-child(2) dd')?.textContent).toBe('0')
      unmount()
    } finally { unsubscribe(); dispose() }
  })

  it('routes reveal, open and the three copies through the host', async () => {
    const clipboard = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
    const mock = setup()
    renderHeader()

    await menuItem(mock, 'reveal').onSelect?.()
    await menuItem(mock, 'open-external').onSelect?.()
    expect(mock.osFileActions).toEqual([
      { action: 'reveal', relPath: FOCUS_PATH },
      { action: 'openWithDefaultApp', relPath: FOCUS_PATH }
    ])

    await menuItem(mock, 'copy-relative').onSelect?.()
    await menuItem(mock, 'copy-absolute').onSelect?.()
    await menuItem(mock, 'copy-link').onSelect?.()
    expect(clipboard.mock.calls.flat()).toEqual([
      FOCUS_PATH,
      `/mock/vault/${FOCUS_PATH}`,
      `valley://open?file=${encodeURIComponent(FOCUS_PATH)}`
    ])
  })

  // `api.getState().activePath` is null on a plugin tab, so a file-scoped item
  // built unconditionally here would be permanently inert.
  it('keeps unfocused graph menus limited to graph actions', () => {
    setup()
    renderHeader()

    const items = graphSurfaceActions(null)
    for (const id of ['reveal', 'open-external', 'copy-relative', 'copy-absolute', 'copy-link']) {
      expect(items.find((item) => item.id === id)).toBeUndefined()
    }
    expect(items.every((item) => item.type === 'separator' || item.enabled !== false || item.id === 'unpin-all')).toBe(true)

    expect(items.map(item => item.id)).toEqual(['animate', 'unpin-all'])
    expect(graphSurfaceActions(null, true).map(item => item.id)).toEqual(['unpin-all'])
  })

  it('replays history from the ⋯ menu, never from Display', async () => {
    setup()
    const surface = renderHook(() => useGraphSurface('main_workspace'))
    const animate = graphSurfaceActions(null)[0]
    expect(animate).toMatchObject({ id: 'animate', label: 'Animate history' })
    expect(animate.icon).toBeTruthy()
    expect(graphSurfaceActions(null, true).some((item) => item.id === 'animate')).toBe(false)
    const before = surface.result.current.animationRun
    act(() => { void animate.onSelect?.() })
    expect(surface.result.current.animationRun).toBe(before + 1)

    await act(async () => { render(React.createElement(GraphControls, { config: DEFAULT_CONFIG, onChange: () => {}, section: 'display', onSection: () => {}, legend: true })) })
    expect(screen.queryByRole('button', { name: 'Animate history' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'Legend' })).toBeTruthy()
  })
})

describe('graph sidebar panel', () => {
  // The header only names the panel; saved graphs live in the row below it.
  it('keeps the header to the title and open button and names the graph below it', async () => {
    const mock = setup()
    await mock.api.settings.set('savedGraphs', [{ name: 'Habitats' }])
    await mock.api.settings.set('activeGraph', 'Habitats')
    const { container } = render(React.createElement(GlobalGraph))
    await act(async () => {})

    const header = container.querySelector('.panel-header')
    expect(header?.querySelector('.panel-title')?.textContent).toBe('Graph')
    expect([...(header?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label'))).toEqual(['Open graph'])
    const row = container.querySelector('.graphview-namebar')
    expect(row?.previousElementSibling).toBe(header)
    expect(screen.getByRole('button', { name: 'Saved graph: Habitats' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New graph' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open graph' }))
    expect(mock.api.workspace.openMainTab).toHaveBeenCalled()
  })

  it('shows the Default graph and three sections without Plugins or reset', async () => {
    setup()
    const { container } = render(React.createElement(GlobalGraph))
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Saved graph: Default graph' })).toBeTruthy()
    expect([...container.querySelectorAll('.graphview-chip')].map((chip) => chip.getAttribute('aria-label'))).toEqual(['Filters', 'Color groups', 'Display'])
    expect(screen.queryByRole('button', { name: 'Restore defaults' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Plugins' })).toBeNull()
  })

  it('creates a whole-vault graph from + and keeps the header naming the panel', async () => {
    setup()
    const store = storeFor(GLOBAL_KEYS)
    act(() => store.apply({ ...store.get().config, display: { ...store.get().config.display, nodeSize: 2 } }))
    const { container } = render(React.createElement(GlobalGraph))
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', { name: 'New graph' }))
    expect(container.querySelector('.panel-title')?.textContent).toBe('Graph')
    const field = screen.getByRole('textbox', { name: 'Graph name' })
    fireEvent.change(field, { target: { value: '  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(field).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(field, { target: { value: 'Wetlands' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(store.get()).toMatchObject({ active: 'Wetlands', config: DEFAULT_CONFIG })
    expect(store.get().defaultConfig.display.nodeSize).toBe(2)
    expect(screen.getByRole('button', { name: 'Saved graph: Wetlands' })).toBeTruthy()
  })

  it('switches, renames and deletes from the name menu, with ⌘Z restoring a deleted graph', async () => {
    const mock = setup()
    const store = storeFor(GLOBAL_KEYS)
    act(() => { store.saveAs('Habitats'); store.select('') })
    render(React.createElement(GlobalGraph))
    await act(async () => {})

    const menu = pickFromMenu(mock, 'graph:Habitats')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Saved graph: Default graph' })) })
    expect(menu.items().filter((item) => item.type === 'radio').map((item) => [item.label, item.checked])).toEqual([['Default graph', true], ['Habitats', false]])
    expect(menu.items().filter((item) => item.type !== 'radio' && item.type !== 'separator').every((item) => item.icon)).toBe(true)
    expect(store.get().active).toBe('Habitats')

    pickFromMenu(mock, 'rename')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Saved graph: Habitats' })) })
    const field = screen.getByRole('textbox', { name: 'Graph name' })
    expect(field).toHaveValue('Habitats')
    fireEvent.change(field, { target: { value: 'Moss beds' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(store.get().active).toBe('Moss beds')

    vi.spyOn(mock.api.ui, 'confirm').mockResolvedValueOnce('delete')
    pickFromMenu(mock, 'delete')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Saved graph: Moss beds' })) })
    expect(store.get()).toMatchObject({ active: '', saved: [] })
    expect(mock.undoActions.at(-1)?.label).toBe('Delete graph “Moss beds”')
    await act(async () => { await mock.undoActions.at(-1)!.undo() })
    expect(store.get().active).toBe('Moss beds')
    expect(screen.getByRole('button', { name: 'Saved graph: Moss beds' })).toBeTruthy()
  })
})

describe('graph filters', () => {
  it('starts from the whole vault, narrows it from the base field and subtracts exclusions', async () => {
    setup()
    const onChange = vi.fn()
    const view = render(React.createElement(GraphControls, { config: DEFAULT_CONFIG, onChange, section: 'filters', onSection: () => {} }))
    const base = screen.getByRole('textbox', { name: 'Start from' })
    expect(base).toHaveAttribute('placeholder', 'Whole vault')
    await waitFor(() => expect(view.container.querySelector('.graphview-base .graphview-count')?.textContent).toBe('2'))

    fireEvent.change(base, { target: { value: 'path:Fern' } })
    expect(onChange.mock.lastCall?.[0].filters.rules).toEqual([expect.objectContaining({ query: 'path:Fern', exclude: false })])

    fireEvent.click(screen.getByRole('button', { name: 'Add exclusion' }))
    expect(onChange.mock.lastCall?.[0].filters.rules).toEqual([expect.objectContaining({ query: '', exclude: true })])
    expect(screen.queryByRole('button', { name: 'Add filter' })).toBeNull()
  })

  it('counts what each exclusion removes and removes rows from inside the field', async () => {
    setup()
    const onChange = vi.fn()
    const rules = [{ id: 'fungi', query: 'fungus', exclude: true }]
    const config = { ...DEFAULT_CONFIG, filters: { ...DEFAULT_CONFIG.filters, rules } }
    const view = render(React.createElement(GraphControls, { config, onChange, section: 'filters', onSection: () => {} }))
    await waitFor(() => expect(view.container.querySelector('.graphview-exclusion .graphview-count')?.textContent).toBe('−1'))
    expect(screen.getByRole('textbox', { name: 'Exclude' })).toHaveValue('fungus')
    fireEvent.click(screen.getByRole('button', { name: 'Remove exclusion' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...config, filters: { ...config.filters, rules: [] } })
  })

  it('gives each shared-item owner a named switch and color under the file switches', async () => {
    const mock = setup()
    mock.api.documents.sources = async () => [
      { pluginId: 'fieldwork', sourceId: 'local', label: 'Fieldwork' },
      { pluginId: 'fieldwork', sourceId: 'remote', label: 'Fieldwork' },
      { pluginId: 'observations', sourceId: 'notes', label: 'Observations' }
    ]
    await act(async () => { render(React.createElement(GlobalGraph)) })
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Observations' })).toBeTruthy())
    expect(screen.getAllByRole('switch').map((toggle) => toggle.getAttribute('aria-label'))).toEqual(['Existing files only', 'Orphans', 'Attachments', 'Tags', 'Fieldwork', 'Observations'])
    expect(screen.getByRole('switch', { name: 'Fieldwork' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Color for Fieldwork' })).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Fieldwork' }))
    expect(storeFor(GLOBAL_KEYS).get().config.plugins).toEqual({ fieldwork: false })
  })

  it('keeps color groups compact, ordered and immediately useful', async () => {
    setup()
    const onChange = vi.fn()
    const groups = [
      { id: 'fungi', query: 'path:Fungi/', color: paletteRef('green') },
      { id: 'canopy', query: 'tag:canopy', color: paletteRef('violet') }
    ]
    const config = { ...DEFAULT_CONFIG, colorGroups: groups }
    await act(async () => {
      render(React.createElement(GraphControls, {
        config,
        onChange,
        section: 'groups',
        onSection: () => {}
      }))
    })

    expect(screen.getByText('Color groups')).toBeTruthy()
    expect(screen.getByText(/Higher groups win/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Color for path:Fungi/' })).toHaveAttribute('data-color', paletteRef('green'))

    fireEvent.change(screen.getByRole('textbox', { name: 'Group 1 query' }), { target: { value: 'path:Moss/' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...config, colorGroups: [{ ...groups[0], query: 'path:Moss/' }, groups[1]] })

    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder path:Fungi/' }), { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith({ ...config, colorGroups: [groups[1], groups[0]] })

    fireEvent.click(screen.getByRole('button', { name: 'Add group' }))
    expect(onChange).toHaveBeenLastCalledWith({
      ...config,
      colorGroups: [...groups, expect.objectContaining({ query: '', color: paletteRef('primary-blue') })]
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove path:Fungi/' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...config, colorGroups: [groups[1]] })
  })

  it('emits every display and force control shown in Graph settings', async () => {
    setup()
    const onChange = vi.fn()
    await act(async () => {
      render(React.createElement(GraphControls, {
        config: DEFAULT_CONFIG,
        onChange,
        section: 'display',
        onSection: () => {}
      }))
    })

    fireEvent.click(screen.getByRole('switch', { name: 'Arrows' }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      display: expect.objectContaining({ showArrows: true })
    }))
    expect(screen.queryByRole('switch', { name: 'Legend' })).toBeNull()

    for (const [name, branch, key, value] of [
      ['Text fade', 'display', 'textFade', 0.8],
      ['Node size', 'display', 'nodeSize', 1.8],
      ['Link thickness', 'display', 'linkThickness', 1.6],
      ['Center', 'forces', 'center', 1.4],
      ['Repel', 'forces', 'repel', 2.1],
      ['Link', 'forces', 'link', 1.7],
      ['Link distance', 'forces', 'linkDistance', 140]
    ] as const) {
      fireEvent.change(screen.getByRole('slider', { name }), { target: { value: String(value) } })
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
        [branch]: expect.objectContaining({ [key]: value })
      }))
    }
  })

  it('exposes colors beside tag, attachment and orphan switches', async () => {
    setup()
    await act(async () => {
      render(React.createElement(GraphControls, {
        config: DEFAULT_CONFIG,
        onChange: () => {},
        section: 'filters',
        onSection: () => {}
      }))
    })
    for (const label of ['Tags', 'Attachments', 'Orphans']) {
      expect(screen.getByRole('button', { name: `Color for ${label}` })).toBeTruthy()
    }
  })
})

describe('graph documents and surface state', () => {
  it('refreshes only committed document identities after the initial metadata query', async () => {
    const ref = { pluginId: 'fieldwork', sourceId: 'notes', itemId: 'fern' }
    const document: NoteDocument = { id: 'plugin:fieldwork/notes/fern', ref, title: 'Fern', body: '', explicitTags: [], tags: [], links: [], readOnly: false, revision: 1, vaultGeneration: 1, navigation: { command: 'fieldwork:open', args: { id: 'fern' } } }
    const mock = createMockValleyApi({ manifest: { id: 'graphView' }, documents: [document] })
    validatePublishedResults(mock)
  initRuntime(mock.api)
    const query = vi.spyOn(mock.api.documents, 'query')
    const read = vi.spyOn(mock.api.documents, 'read')
    const hook = renderHook(useNoteDocuments)
    await waitFor(() => expect(hook.result.current.documents).toHaveLength(1))
    await act(async () => { await mock.api.documents.update(ref, { body: '# New body', expectedRevision: 1, vaultGeneration: 1 }) })
    expect(query).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(ref)
    expect(hook.result.current.documents[0].body).toBe('# New body')
  })

  it('re-reads translated source labels when the app language changes', async () => {
    const mock = setup()
    let changeLanguage: (() => void) | undefined
    vi.spyOn(mock.api.ui, 'onLanguageChanged').mockImplementation((listener) => { changeLanguage = listener; return () => {} })
    const sources = vi.spyOn(mock.api.documents, 'sources').mockResolvedValue([{ pluginId: 'fieldwork', sourceId: 'notes', label: 'Fieldwork' }])
    const hook = renderHook(useNoteDocuments)
    await waitFor(() => expect(hook.result.current.sources[0]?.label).toBe('Fieldwork'))
    sources.mockResolvedValue([{ pluginId: 'fieldwork', sourceId: 'notes', label: 'Feldarbeit' }])
    await act(async () => { changeLanguage?.() })
    await waitFor(() => expect(hook.result.current.sources[0]?.label).toBe('Feldarbeit'))
    hook.unmount()
  })

  it('does not continue a retired document load against a replacement plugin API', async () => {
    const owner = createMockValleyApi({ manifest: { id: 'graphView' } })
    const replacement = createMockValleyApi({ manifest: { id: 'graphView' } })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const sources = vi.spyOn(owner.api.documents, 'sources').mockImplementation(async () => { await held; return [] })
    const oldQuery = vi.spyOn(owner.api.documents, 'query')
    const newQuery = vi.spyOn(replacement.api.documents, 'query')
    initRuntime(owner.api)
    const hook = renderHook(useNoteDocuments)
    await waitFor(() => expect(sources).toHaveBeenCalledOnce())
    hook.unmount()
    initRuntime(replacement.api)
    await act(async () => { release(); await held })
    expect(oldQuery).not.toHaveBeenCalled()
    expect(newQuery).not.toHaveBeenCalled()
  })

  it('discards old-vault pages and stops paging after the captured vault changes', async () => {
    const mock = setup()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const query = vi.spyOn(mock.api.documents, 'query').mockImplementationOnce(async () => {
      await held
      return { documents: [], cursor: 'next-page' }
    })
    const hook = renderHook(useNoteDocuments)
    await waitFor(() => expect(query).toHaveBeenCalledOnce())
    await act(async () => { mock.emitState({ vault: { path: '/mock/other', name: 'other', displayName: 'other' } }) })
    await act(async () => { release(); await held })
    expect(query).toHaveBeenCalledOnce()
    expect(hook.result.current).toEqual({ documents: [], sources: [], error: '' })
    hook.unmount()
  })

  it('restores the saved graph and centre without rolling the graph back, and keeps saved-graph commands reversible', async () => {
    const mock = setup()
    const off = registerGraph(mock.api)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'main_workspace')!.extension
    await surface.restore({ centerId: FOCUS_PATH, section: 'plugins', config: { ...DEFAULT_CONFIG, display: { ...DEFAULT_CONFIG.display, nodeSize: 2 } } }, undefined, { background: true })
    expect(surface.getSnapshot().item?.id).toBe(FOCUS_PATH)
    expect(surface.getSnapshot().view).toEqual({ preset: '', section: null })
    expect(storeFor(GLOBAL_KEYS).get().config.display.nodeSize).toBe(DEFAULT_CONFIG.display.nodeSize)
    expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
    storeFor(GLOBAL_KEYS).apply({ ...DEFAULT_CONFIG, display: { ...DEFAULT_CONFIG.display, nodeSize: 2 } })
    expect((await mock.api.commands.execute('graphView:preset-save', { name: 'Canopy' })).ok).toBe(true)
    const savedUndo = mock.busUndo.at(-1)!
    const inspected = await mock.api.commands.execute('graphView:inspect', { local: false })
    expect(inspected.ok).toBe(true)
    if (inspected.ok) expect(inspected.value).toMatchObject({ active: 'Canopy', config: { display: { nodeSize: 2 } } })
    expect(await mock.api.commands.execute('graphView:properties-edit', { subject: { pluginId: 'graphView', surface: 'main_workspace', view: {} }, values: { centerId: null } })).toMatchObject({ ok: true, value: { updated: ['centerId'] } })
    await mock.busUndo.at(-1)!.undo()
    expect((await mock.api.commands.execute('graphView:preset-rename', { name: 'Canopy', to: 'Understory' })).ok).toBe(true)
    expect(storeFor(GLOBAL_KEYS).get().active).toBe('Understory')
    await mock.busUndo.at(-1)!.undo()
    expect(storeFor(GLOBAL_KEYS).get().active).toBe('Canopy')
    await savedUndo.undo()
    expect((surface.getSnapshot().view as { preset: string }).preset).toBe('')
    await expect(Promise.resolve().then(() => surface.restore({ centerId: 'Missing.md' }))).rejects.toThrow('unavailable')
    off()
  })

  it('undoes focus back to the previous centre as well as the previous filter', async () => {
    const mock = setup()
    const off = registerGraph(mock.api)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'main_workspace')!.extension
    await surface.restore({ centerId: 'Shelf Fungus.md' }, undefined, { background: true })
    const before = structuredClone(storeFor(GLOBAL_KEYS).get())
    expect(await mock.api.commands.execute('graphView:focus', { path: FOCUS_PATH })).toMatchObject({ ok: true, value: { path: FOCUS_PATH } })
    expect(surface.getSnapshot().item?.id).toBe(FOCUS_PATH)
    expect(storeFor(GLOBAL_KEYS).get().config.filters.rules).toEqual([{ id: 'f0', query: `path:"${FOCUS_PATH}"`, exclude: false }])
    await mock.busUndo.at(-1)!.undo()
    expect(surface.getSnapshot().item?.id).toBe('Shelf Fungus.md')
    expect(storeFor(GLOBAL_KEYS).get()).toEqual(before)
    off()
  })

  it('refuses graph writes before any effect as not-applied with a code', async () => {
    const mock = setup()
    const off = registerGraph(mock.api)
    const command = (id: string) => mock.commands.find((entry) => entry.id === id)!
    const run = (id: string, input: unknown) => Promise.resolve().then(() => command(id).run(command(id).input!.parse(input), { caller: 'agent', dryRun: false } as never))
    await mock.api.commands.execute('graphView:preset-save', { name: 'Canopy' })
    await mock.api.commands.execute('graphView:preset-save', { name: 'Moss' })
    const before = structuredClone(storeFor(GLOBAL_KEYS).get())
    const settingsWrites = vi.spyOn(mock.api.settings, 'set')
    const subject = { pluginId: 'graphView', surface: 'main_workspace', view: {} }
    await expect(run('focus', { path: 'Missing.md' })).rejects.toMatchObject({ code: 'GRAPH_NODE_UNAVAILABLE', outcome: 'not-applied' })
    await expect(run('properties-edit', { subject, values: { preset: 'Missing' } })).rejects.toMatchObject({ code: 'GRAPH_PRESET_UNAVAILABLE', outcome: 'not-applied' })
    await expect(run('properties-edit', { subject, values: { centerId: 'Missing.md', config: DEFAULT_CONFIG } })).rejects.toMatchObject({ code: 'GRAPH_NODE_UNAVAILABLE', outcome: 'not-applied' })
    for (const operation of ['select', 'rename', 'delete']) {
      await expect(run(`preset-${operation}`, { name: 'Missing', to: 'Other' })).rejects.toMatchObject({ code: 'GRAPH_PRESET_UNAVAILABLE', outcome: 'not-applied' })
    }
    await expect(run('preset-rename', { name: 'Canopy', to: 'moss' })).rejects.toMatchObject({ code: 'GRAPH_PRESET_NAME_INVALID', outcome: 'not-applied' })
    expect(settingsWrites).not.toHaveBeenCalled()
    expect(storeFor(GLOBAL_KEYS).get()).toEqual(before)
    expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
    const focus = command('focus')
    off()
    await expect(Promise.resolve().then(() => focus.run(focus.input!.parse({ path: FOCUS_PATH }), { caller: 'agent', dryRun: false } as never))).rejects.toMatchObject({ code: 'GRAPH_UNAVAILABLE', outcome: 'not-applied' })
    expect(settingsWrites).not.toHaveBeenCalled()
  })

  it('rolls a graph edit back and reports an unknown outcome when its settings commit fails', async () => {
    const mock = setup()
    const off = registerGraph(mock.api)
    const command = (id: string) => mock.commands.find((entry) => entry.id === id)!
    const run = (id: string, input: unknown) => Promise.resolve().then(() => command(id).run(command(id).input!.parse(input), { caller: 'agent', dryRun: false } as never))
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'main_workspace')!.extension
    await surface.restore({ centerId: 'Shelf Fungus.md' }, undefined, { background: true })
    const before = structuredClone(storeFor(GLOBAL_KEYS).get())
    const persisted = () => ({ config: readConfig(GLOBAL_KEYS), saved: readSavedGraphs(GLOBAL_KEYS), active: readActiveGraph(GLOBAL_KEYS) })
    const persistedBefore = structuredClone(persisted())
    const write = vi.spyOn(mock.api.settings, 'set').mockRejectedValueOnce(new Error('Synthetic save failure'))
    const subject = { pluginId: 'graphView', surface: 'main_workspace', view: {} }
    const edited = { ...DEFAULT_CONFIG, display: { ...DEFAULT_CONFIG.display, nodeSize: 2.4 } }
    await expect(run('properties-edit', { subject, values: { centerId: FOCUS_PATH, config: edited } })).rejects.toMatchObject({ outcome: 'unknown', message: 'Synthetic save failure' })
    expect(surface.getSnapshot().item?.id).toBe('Shelf Fungus.md')
    expect(storeFor(GLOBAL_KEYS).get()).toEqual(before)
    expect(persisted()).toEqual(persistedBefore)
    write.mockRejectedValueOnce(new Error('Synthetic save failure'))
    await expect(run('search', { query: 'tag:moss' })).rejects.toMatchObject({ outcome: 'unknown' })
    expect(storeFor(GLOBAL_KEYS).get()).toEqual(before)
    expect(persisted()).toEqual(persistedBefore)
    write.mockRestore()
    off()
  })

  it('rolls saved-graph commands back with an unknown outcome when their commit fails, and says when the rollback failed too', async () => {
    const mock = setup()
    const off = registerGraph(mock.api)
    const command = (id: string) => mock.commands.find((entry) => entry.id === id)!
    const run = (id: string, input: unknown) => Promise.resolve().then(() => command(id).run(command(id).input!.parse(input), { caller: 'agent', dryRun: false } as never))
    await mock.api.commands.execute('graphView:preset-save', { name: 'Canopy' })
    await mock.api.commands.execute('graphView:preset-save', { name: 'Moss' })
    const before = structuredClone(storeFor(GLOBAL_KEYS).get())
    const persisted = () => ({ config: readConfig(GLOBAL_KEYS), saved: readSavedGraphs(GLOBAL_KEYS), active: readActiveGraph(GLOBAL_KEYS) })
    const persistedBefore = structuredClone(persisted())
    const set = mock.api.settings.set.bind(mock.api.settings)
    const stored = structuredClone(mock.api.settings.get()) as Record<string, unknown>
    // Every write of a changed value fails; writing the prior value back (the rollback) succeeds.
    const write = vi.spyOn(mock.api.settings, 'set').mockImplementation(async (...args: Parameters<typeof set>) => {
      if (JSON.stringify(args[1]) !== JSON.stringify(stored[args[0]])) throw new Error('Synthetic save failure')
      return set(...args)
    })
    for (const [operation, input] of [['save', { name: 'Fern' }], ['select', { name: 'Canopy' }], ['rename', { name: 'Canopy', to: 'Understory' }], ['delete', { name: 'Canopy' }]] as const) {
      await expect(run(`preset-${operation}`, input), operation).rejects.toMatchObject({ outcome: 'unknown', rollback: 'restored', message: 'Synthetic save failure' })
      expect(storeFor(GLOBAL_KEYS).get(), operation).toEqual(before)
      expect(persisted(), operation).toEqual(persistedBefore)
    }
    write.mockRejectedValue(new Error('Synthetic save failure'))
    await expect(run('preset-delete', { name: 'Canopy' })).rejects.toMatchObject({ outcome: 'unknown', rollback: 'failed', rollbackError: { message: 'Synthetic save failure' }, message: expect.stringContaining('also failed') })
    write.mockRestore()
    off()
  })

  it('rolls the focus filter back with an unknown outcome when the index goes stale during its commit', async () => {
    const mock = setup()
    const off = registerGraph(mock.api)
    const command = (id: string) => mock.commands.find((entry) => entry.id === id)!
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'main_workspace')!.extension
    await surface.restore({ centerId: 'Shelf Fungus.md' }, undefined, { background: true })
    const before = structuredClone(storeFor(GLOBAL_KEYS).get())
    const persisted = () => ({ config: readConfig(GLOBAL_KEYS), saved: readSavedGraphs(GLOBAL_KEYS), active: readActiveGraph(GLOBAL_KEYS) })
    const persistedBefore = structuredClone(persisted())
    const state = mock.api.getState()
    const set = mock.api.settings.set.bind(mock.api.settings)
    const getState = vi.spyOn(mock.api, 'getState')
    const write = vi.spyOn(mock.api.settings, 'set').mockImplementationOnce(async (...args: Parameters<typeof set>) => {
      getState.mockReturnValue({ ...state, vault: { path: '/mock/other', name: 'other', displayName: 'other' } } as never)
      return set(...args)
    })
    const focus = command('focus')
    await expect(Promise.resolve().then(() => focus.run(focus.input!.parse({ path: FOCUS_PATH }), { caller: 'agent', dryRun: false } as never))).rejects.toMatchObject({ outcome: 'unknown', rollback: 'restored' })
    expect(write.mock.calls.length).toBeGreaterThan(1)
    expect(storeFor(GLOBAL_KEYS).get()).toEqual(before)
    expect(persisted()).toEqual(persistedBefore)
    expect(surface.getSnapshot().item?.id).toBe('Shelf Fungus.md')
    expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
    getState.mockRestore()
    write.mockRestore()
    off()
  })

  it('declares the window-changing open commands as execute, not read', () => {
    const mock = setup()
    const off = registerGraph(mock.api)
    const effects = Object.fromEntries(mock.api.commands.list().map((command) => [command.id, command.sideEffect]))
    expect(effects).toMatchObject({ 'graphView:open': 'execute', 'graphView:open-local': 'execute', 'graphView:inspect': 'read' })
    off()
  })
})


describe('local graph sidebar', () => {
  it('has two bars, no color groups or create action, and independent persisted depth and arrows per graph', async () => {
    const mock = setup()
    await mock.api.settings.set('savedGraphs', [{ ...DEFAULT_CONFIG, name: 'Habitats', display: { ...DEFAULT_CONFIG.display, nodeSize: 2 } }])
    mock.emitState({ activePath: FOCUS_PATH })
    const { container, unmount } = render(React.createElement(LocalGraph))
    await act(async () => {})
    expect(container.querySelectorAll('.graphview-namebar, .graphview-depthbar')).toHaveLength(2)
    expect(container.querySelector('.graphview-chipbar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Color groups' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New graph' })).toBeNull()
    const menu = pickFromMenu(mock, 'graph:Habitats')
    fireEvent.click(screen.getByRole('button', { name: 'Saved graph: Default graph' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved graph: Habitats' })).toBeTruthy())
    expect(menu.items().map((item) => item.id)).toEqual(['graph:', 'graph:Habitats'])
    expect(storeFor(LOCAL_KEYS).get().config.display.nodeSize).toBe(2)
    const depth = screen.getByRole('slider', { name: 'Depth' })
    expect(depth).toHaveAttribute('max', '10')
    fireEvent.change(depth, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Arrows' }))
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))
    expect(screen.queryByRole('switch', { name: 'Arrows' })).toBeNull()
    await act(async () => { await mock.runBeforeUnload() })
    expect(storeFor(GLOBAL_KEYS).get().saved[0]).toMatchObject({ localDepth: 1, display: { showArrows: false } })
    expect(storeFor(LOCAL_KEYS).get().config).toMatchObject({ localDepth: 10, display: { showArrows: true } })
    unmount()
    await act(async () => { render(React.createElement(LocalGraph)) })
    expect(new PresetStore(LOCAL_KEYS).get().config).toMatchObject({ localDepth: 10, display: { showArrows: true } })
    expect(screen.getByRole('slider', { name: 'Depth' })).toHaveValue('10')
    expect(screen.getByRole('button', { name: 'Arrows' })).toHaveAttribute('aria-pressed', 'true')
    await act(async () => { storeFor(LOCAL_KEYS).select(''); await mock.runBeforeUnload() })
    expect(screen.getByRole('slider', { name: 'Depth' })).toHaveValue('1')
    await act(async () => { storeFor(LOCAL_KEYS).select('Habitats'); await mock.runBeforeUnload() })
    expect(screen.getByRole('slider', { name: 'Depth' })).toHaveValue('10')
  })

  it('says the active file is not part of the graph instead of blaming the filters', async () => {
    const mock = setup()
    mock.emitState({ activePath: 'Quiz/Mosses.quiz' })
    const { container } = render(React.createElement(LocalGraph))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await waitFor(() => expect(container.querySelector('.graphview-empty')?.textContent).toBe('This file is not part of the graph.'))
    await act(async () => { mock.emitState({ activePath: FOCUS_PATH }); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(container.querySelector('.graphview-empty')).toBeNull()
  })

  it('keeps both local header rows visible when no file is active', async () => {
    setup()
    const { container } = render(React.createElement(LocalGraph))
    await act(async () => {})
    expect(container.querySelectorAll('.graphview-namebar, .graphview-depthbar')).toHaveLength(2)
    expect(container.querySelector('canvas')).toBeNull()
  })
})


describe('saved graph deletion confirmation', () => {
  it.each(['cancel', null])('keeps the graph when the modal returns %s', async choice => {
    const mock = setup()
    const store = storeFor(GLOBAL_KEYS)
    store.saveAs('Wetlands')
    render(React.createElement(GlobalGraph))
    const confirm = vi.spyOn(mock.api.ui, 'confirm').mockResolvedValueOnce(choice)
    pickFromMenu(mock, 'delete')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Saved graph: Wetlands' })) })
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Delete graph?', message: expect.stringContaining('Wetlands'),
      actions: [{ label: 'Cancel', value: 'cancel', variant: 'ghost' }, { label: 'Delete', value: 'delete', variant: 'danger' }]
    }))
    expect(store.get().saved.map(graph => graph.name)).toEqual(['Wetlands'])
    expect(store.get().active).toBe('Wetlands')
  })

  it('deletes only the confirmed graph when the active graph changes while waiting', async () => {
    const mock = setup()
    const store = storeFor(GLOBAL_KEYS)
    store.saveAs('Wetlands')
    store.saveAs('Canopy')
    store.select('Wetlands')
    render(React.createElement(GlobalGraph))
    let resolve!: (value: string) => void
    vi.spyOn(mock.api.ui, 'confirm').mockImplementationOnce(() => new Promise(done => { resolve = done }))
    pickFromMenu(mock, 'delete')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Saved graph: Wetlands' })) })
    expect(store.get().saved).toHaveLength(2)
    act(() => store.select('Canopy'))
    await act(async () => resolve('delete'))
    expect(store.get().active).toBe('Canopy')
    expect(store.get().saved.map(graph => graph.name)).toEqual(['Canopy'])
  })
})

it('lists registered empty sources in Graph settings and shares switches with the graph', async () => {
  const mock = setup()
  mock.api.documents.sources = async () => [
    { pluginId: 'observations', sourceId: 'notes', label: 'Observations' },
    { pluginId: 'fieldwork', sourceId: 'inbox', label: 'Fieldwork' },
    { pluginId: 'fieldwork', sourceId: 'archive', label: 'Fieldwork' }
  ]
  vi.spyOn(mock.api.backend, 'call').mockResolvedValue([
    { id: 'fieldwork', name: 'Fieldwork', version: '1.2.3', author: ['Ada'], nodeTypes: ['Field notes', 'Observations'], linksSourceFiles: true },
    { id: 'observations', name: 'Observations', version: '2.0.0', author: [], nodeTypes: ['Observations'], linksSourceFiles: false },
    { id: 'unregistered', name: 'Not a graph source', version: '1.0.0', author: [], nodeTypes: [], linksSourceFiles: false }
  ])
  const configure = vi.spyOn(mock.api.workspace, 'openSettings')
  const { container } = render(React.createElement(GraphSourceSettings))
  await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(2))
  await waitFor(() => expect(screen.getByText('1.2.3 · Ada')).toBeTruthy())
  expect(container.querySelectorAll('.settings-plugin-card')).toHaveLength(2)
  expect(screen.getByText('Adds graph nodes from: Field notes, Observations. Connects each item to its source file and links in its notes. Shows its tags when Tags is enabled.')).toBeTruthy()
  expect(screen.getByText('Adds graph nodes from: Observations. Connects links in their notes and shows their tags when Tags is enabled.')).toBeTruthy()
  expect(container.querySelector('.graphview-source-intro')).toBeTruthy()
  expect(screen.queryByText('Not a graph source')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Configure Fieldwork' }))
  expect(configure).toHaveBeenCalledWith('plugin:fieldwork')
  expect(screen.getAllByRole('switch').map(toggle => toggle.getAttribute('aria-label'))).toEqual(['Fieldwork', 'Observations'])
  fireEvent.click(screen.getByRole('switch', { name: 'Fieldwork' }))
  expect(storeFor(GLOBAL_KEYS).get().config.plugins).toEqual({ fieldwork: false })
})
