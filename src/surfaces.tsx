import { graphResults } from './commands'
import { subscribeRuntimePalette } from '@valley/plugin-sdk/palette'
import { METADATA_PANEL_SEGMENT_V1, provideBookmarkSurface, WORKSPACE_DETAILS_V1, parseNoteDocumentId, type PluginInspectionSubject, type PluginProperty, type UiMenuItem, type ValleyPluginApi } from '@valley/plugin-sdk'
import { absoluteVaultPath, buildAppOpenUrl, type PluginLinkState } from '@valley/plugin-sdk/paths'
import type { SlotId, WorkspaceViewStateValue } from '@valley/plugin-sdk/types'
import { React, api } from './runtime'
import { storeFor, useGraphPresets, type PresetStore, type StoreState } from './presets'
import { GLOBAL_KEYS, LOCAL_KEYS, mergeConfig, readPins, writePins } from './settings'
import { GRAPH_SECTIONS, type GraphSection } from './GraphControls'
import { Copy, ExternalLink, FolderOpen, History, PinOff } from './icons'
import { uiText } from './localization'
import { getGraphIndex, type GraphIndex } from './indexOwner'
import { createGraphProjection, findMatches } from './graphModel'
import { queryMatcher } from './filters'
import { GraphSearchInput } from './GraphTabHeader'
import { useGraphProjection, useIndexEntries, useNoteDocuments } from './useGraph'
import type { InteropValueSchema } from '@valley/plugin-sdk'

const bookmarkStateSchema = {
  "type": "object",
  "properties": {
    "preset": {
      "type": "string"
    },
    "section": {
      "type": "union",
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "centerId": {
      "type": "string"
    }
  },
  "required": [
    "preset",
    "section"
  ],
  "additionalProperties": false
} satisfies InteropValueSchema



interface GraphView { centerId: string | null; section: GraphSection | null; animationRun: number; search: string; focusId: string | null; focusRun: number }
interface SurfaceState { views: Map<SlotId, GraphView>; listeners: Set<() => void> }
function state(): SurfaceState { return api.runtime.getOrCreate('graphView.surfaces', () => ({ views: new Map(), listeners: new Set() })) }
function view(surface: SlotId): GraphView {
  let value = state().views.get(surface)
  if (!value) { value = { centerId: null, section: surface === 'left_sidebar' ? 'filters' : null, animationRun: 0, search: '', focusId: null, focusRun: 0 }; state().views.set(surface, value) }
  return value
}
function notify(): void { state().listeners.forEach((listener) => listener()) }
function subscribe(listener: () => void): () => void {
  const listeners = state().listeners
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function patchGraphSurface(surface: SlotId, patch: Partial<GraphView>): void { Object.assign(view(surface), patch); notify() }
export function readGraphSurface(surface: SlotId): GraphView { return { ...view(surface) } }

/** A refusal raised before a command's first effect: the bus settles it as not-applied, never as an unknown outcome. */
export const refuse = (code: string, message: string): Error => Object.assign(new Error(message), { code, outcome: 'not-applied' as const })
const notApplied = (cause: unknown): unknown => (cause as { outcome?: unknown })?.outcome === 'not-applied' ? cause : Object.assign(refuse('GRAPH_UNAVAILABLE', cause instanceof Error ? cause.message : String(cause)), { cause })
/** Runs the checks that precede a command's first effect, so any failure in them is a known no-effect refusal. */
export function beforeEffect<T>(check: () => T): T {
  try {
    const result = check()
    return (result instanceof Promise ? result.catch((cause: unknown) => { throw notApplied(cause) }) : result) as T
  } catch (cause) { throw notApplied(cause) }
}
/**
 * Rolls the store (and any view change via `rollback`) back to `prior` after an
 * edit failed past its first effect, and returns the error to throw. The outcome
 * stays unknown, because some settings writes may already have landed; the
 * error says whether the rollback itself landed, so a double failure is diagnosable.
 */
export async function abandonGraphEdit(store: PresetStore, prior: StoreState, cause: unknown, rollback: () => void = () => {}): Promise<Error> {
  const message = cause instanceof Error ? cause.message : String(cause)
  let restored = false
  let rollbackError: unknown
  try { await store.restore(prior); restored = true } catch (error) { rollbackError = error } finally { rollback() }
  if (restored) return Object.assign(new Error(message), { cause, outcome: 'unknown' as const, rollback: 'restored' as const })
  const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
  return Object.assign(new Error(`${message} Restoring the previous graph settings also failed: ${rollbackMessage}`), { cause, outcome: 'unknown' as const, rollback: 'failed' as const, rollbackError })
}
/**
 * Applies a graph edit and commits it. A failed commit rolls the store (and any
 * view change via `rollback`) back to `prior` and reports the outcome as unknown.
 */
export async function commitGraphEdit(store: PresetStore, prior: StoreState, effect: () => void, rollback: () => void = () => {}): Promise<void> {
  try {
    effect()
    await store.commit()
  } catch (cause) {
    throw await abandonGraphEdit(store, prior, cause, rollback)
  }
}
export function animateGraph(surface: SlotId = 'main_workspace'): void {
  patchGraphSurface(surface, { animationRun: view(surface).animationRun + 1 })
}
export function useGraphSurface(surface: SlotId): GraphView {
  const [, update] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => subscribe(update), [])
  return view(surface)
}
const keysFor = (surface: SlotId) => surface === 'right_sidebar' ? LOCAL_KEYS : GLOBAL_KEYS
const title = (surface: SlotId): string => uiText(surface === 'right_sidebar' ? 'auto.b2a4eaa0dd79' : 'auto.9a7405ebcedd')

export function graphSurfaceActions(focusPath: string | null, local = false): UiMenuItem[] {
  const keys = local ? LOCAL_KEYS : GLOBAL_KEYS
  const vault = api.getState().vault
  const path = focusPath ?? ''
  const copy = (text: string): void => { void navigator.clipboard.writeText(text) }
  return [
    ...(local ? [] : [{ id: 'animate', label: uiText('graph.animate'), icon: <History />, onSelect: () => animateGraph('main_workspace') }]),
    { id: 'unpin-all', label: uiText('auto.f4289396ca57'), icon: <PinOff />, enabled: Object.keys(readPins(keys)).length > 0, onSelect: () => writePins(keys, {}) },
    ...(path ? [
      { type: 'separator' as const },
      { id: 'reveal', label: api.files.revealLabel(), icon: <FolderOpen />, onSelect: () => api.files.revealInFinder(path) },
      { id: 'open-external', label: uiText('auto.713657474390'), icon: <ExternalLink />, onSelect: () => api.files.openWithDefaultApp(path) }
    ] : []),
    ...(path ? [
      { type: 'separator' as const },
      { id: 'copy-relative', label: uiText('auto.75586047078a'), icon: <Copy />, onSelect: () => copy(path) },
      { id: 'copy-absolute', label: uiText('auto.b96d429c4495'), icon: <Copy />, onSelect: () => copy(absoluteVaultPath(vault?.path, path)) },
      { id: 'copy-link', label: uiText('auto.fb3a16f382f8'), icon: <Copy />, onSelect: () => copy(buildAppOpenUrl(path)) }
    ] : [])
  ]
}

async function validateCenter(value: unknown, index: GraphIndex): Promise<string | null> {
  index.assertCurrent()
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string') {
    const ref = parseNoteDocumentId(value)
    if (ref) {
      if (!(await index.api.documents.read(ref))) throw refuse('GRAPH_NODE_UNAVAILABLE', uiText('surface.unavailable'))
      index.assertCurrent()
      return value
    }
  }
  await index.ready()
  index.assertCurrent()
  if (typeof value !== 'string' || (!value.startsWith('tag:') && !index.entries().some((entry) => entry.relPath === value))) throw refuse('GRAPH_NODE_UNAVAILABLE', uiText('surface.unavailable'))
  return value
}

export function GraphSearch(): React.ReactElement {
  const entries = useIndexEntries()
  const { documents, sources, error } = useNoteDocuments()
  const { config } = useGraphPresets(GLOBAL_KEYS)
  const { search, focusId, focusRun } = useGraphSurface('main_workspace')
  const data = useGraphProjection(entries, config.filters, documents, config.plugins, config.colorGroups, config.sourceColors, sources)
  const query = React.useDeferredValue(search)
  const matches = React.useMemo(() => query.trim() ? findMatches(data, query) : [...data.nodes].sort((a, b) => a.label.localeCompare(b.label)).map((node) => node.id), [data, query])
  const nodes = React.useMemo(() => new Map(data.nodes.map((node) => [node.id, node])), [data])
  const index = focusId ? matches.indexOf(focusId) : -1
  const focus = (id: string): void => patchGraphSurface('main_workspace', { focusId: id, focusRun: focusRun + 1 })
  return <div className="graphview-panel graphview-search-panel">
    <GraphSearchInput find={{
      value: search, count: matches.length, index,
      onChange: (value) => patchGraphSurface('main_workspace', { search: value, focusId: null }),
      onStep: (delta) => {
        if (matches.length) focus(matches[index < 0 ? (delta > 0 ? 0 : matches.length - 1) : (index + delta + matches.length) % matches.length])
      }
    }} />
    {error ? <p role="alert" className="graphview-hint graphview-alert">{uiText('graph.plugins.failed')} {error}</p> : null}
    <div className="graphview-search-results" aria-label={uiText('graph.find.results')}>
      {matches.map((id) => {
        const node = nodes.get(id)!
        return <button type="button" key={id} className={`graphview-search-result${id === focusId ? ' active' : ''}`} aria-pressed={id === focusId} onClick={() => focus(id)} title={node.path ?? node.label}>
          <span>{node.label}</span>
          {node.path && node.path !== node.label ? <small>{node.path}</small> : null}
        </button>
      })}
      {!matches.length ? <p className="graphview-hint">{uiText('graph.find.none')}</p> : null}
    </div>
  </div>
}

function GraphInfo({ read }: { read: () => { summary: PluginProperty[]; breakdown: PluginProperty[] } }): React.ReactElement {
  useGraphSurface('main_workspace')
  const { summary, breakdown } = read()
  const rows = (fields: PluginProperty[]) => <dl className="props-info-table">{fields.map((field) => <div className="props-info-row" key={field.id}>
    <dt className="props-info-key">{field.label}</dt>
    <dd className="props-info-value">{typeof field.value === 'number' ? new Intl.NumberFormat(api.ui.language()).format(field.value) : String(field.value ?? '')}</dd>
  </div>)}</dl>
  return <div className="right-panel-body props-info graphview-info">
    {rows(summary)}
    <h3 className="graphview-info-heading">{uiText('graph.info.breakdown')}</h3>
    {rows(breakdown)}
  </div>
}

interface EditInput { subject: PluginInspectionSubject; values: { config?: unknown; preset?: string; centerId?: string | null } }

export function registerGraphSurfaces(pluginApi: ValleyPluginApi): () => void {
  const index = getGraphIndex(pluginApi)
  const projection = createGraphProjection()
  const readInfo = () => {
    const { config, active: name } = storeFor(GLOBAL_KEYS).get()
    const { sources } = index.getDocuments()
    const data = projection.update(index.entries(), config.filters, index.getDocuments().documents, config.plugins, config.colorGroups, config.sourceColors, sources)
    const groups = config.colorGroups.filter((group) => group.query.trim())
    const matchers = groups.map((group) => queryMatcher(group.query))
    const counts = groups.map(() => 0)
    let ungrouped = 0
    for (const node of data.nodes) {
      const group = matchers.findIndex((match) => match(node))
      if (group < 0) ungrouped++
      else counts[group]++
    }
    const field = (id: string, label: string, value: string | number): PluginProperty => ({ id, label, value, readOnly: true })
    return {
      summary: [
        field('name', uiText('graph.name'), name || uiText('graph.default')),
        field('nodes', uiText('graph.info.nodes'), data.nodes.length),
        field('links', uiText('graph.info.links'), data.edges.length),
        field('groups', uiText('graph.info.groups'), groups.length)
      ],
      breakdown: [
        ...groups.map((group, i) => field(`group:${group.id}`, group.query.trim(), counts[i])),
        field('ungrouped', uiText('graph.info.ungrouped'), ungrouped)
      ]
    }
  }
  let active = true
  const assertActive = (): void => { if (!active) throw new Error(uiText('surface.unavailable')); index.assertCurrent() }
  const surfaces = ['main_workspace', 'left_sidebar', 'right_sidebar'] as const
  const offs = [subscribeRuntimePalette(notify), storeFor(GLOBAL_KEYS).subscribe(notify), storeFor(LOCAL_KEYS).subscribe(notify), index.subscribe(notify), index.subscribeDocuments(notify), pluginApi.ui.onLanguageChanged(notify), pluginApi.subscribeState(['activePath', 'vault'], notify), pluginApi.settings.subscribe(notify)]
  offs.push(...surfaces.map((surface) => provideBookmarkSurface(pluginApi, {
    id: `graphView.${surface}`, surface, subscribe,
    getSnapshot: () => {
      const current = view(surface)
      const presets = storeFor(keysFor(surface)).get()
      const centerId = current.centerId ?? (surface === 'right_sidebar' ? pluginApi.getState().activePath : null)
      const entry = index.entries().find((entry) => entry.relPath === centerId)
      // Saved graphs own their settings, so the view names the graph and the
      // open section — restoring never rolls a graph back to an old snapshot.
      const state = { preset: presets.active, section: current.section } as unknown as PluginLinkState
      return { title: title(surface), view: state, ...(centerId ? { item: { id: centerId, title: entry?.title || centerId, state: { ...state, centerId } } } : {}), actions: graphSurfaceActions(entry?.relPath ?? null, surface === 'right_sidebar') }
    },
    restore: async (raw) => {
      assertActive()
      const store = storeFor(keysFor(surface))
      const centerId = await validateCenter(raw.centerId, index)
      assertActive()
      if (typeof raw.preset === 'string' && raw.preset && !store.get().saved.some((preset) => preset.name === raw.preset)) throw new Error(uiText('surface.unavailable'))
      if (raw.preset !== undefined) store.select(String(raw.preset))
      patchGraphSurface(surface, { centerId, section: GRAPH_SECTIONS.includes(raw.section as GraphSection) ? raw.section as GraphSection : null })
    }
  }, { stateSchema: bookmarkStateSchema, itemStateSchema: { ...bookmarkStateSchema, required: [...bookmarkStateSchema.required, "centerId"] }, description: snapshot => String(snapshot.view.preset || uiText('bookmark.view')) })))
  offs.push(pluginApi.interop.extensions.provide(WORKSPACE_DETAILS_V1, {
    id: 'graphView.details', label: 'Graph', labelKey: 'auto.9a7405ebcedd', pluginViews: true,
    items: [
      { id: 'nodes', label: 'Nodes', labelKey: 'graph.info.nodes', kind: 'text' },
      { id: 'links', label: 'Links', labelKey: 'graph.info.links', kind: 'text' },
      { id: 'name', label: 'Graph name', labelKey: 'graph.name', kind: 'text' },
      { id: 'groups', label: 'Groups', labelKey: 'graph.info.groups', kind: 'text' }
    ],
    defaultItems: ['nodes', 'links'], subscribe,
    getSnapshot: () => ({ items: Object.fromEntries(readInfo().summary.map((field) => [field.id, {
      text: field.id === 'name' ? String(field.value) : `${field.label}: ${new Intl.NumberFormat(pluginApi.ui.language()).format(Number(field.value))}`
    }])) })
  }))
  offs.push(pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, {
    id: 'graphView.info', label: 'Info', labelKey: 'graph.info', icon: 'info', pluginSurfaces: ['main_workspace'],
    inspect: () => { const { summary, breakdown } = readInfo(); return [...summary, ...breakdown] },
    render: () => <GraphInfo read={readInfo} />
  }))
  offs.push(pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, {
    id: 'graphView.properties', label: 'Search', labelKey: 'graph.search', icon: 'search', pluginSurfaces: ['main_workspace'], editCommand: 'properties-edit',
    inspect: ({ subject }) => {
      const surface = subject?.surface ?? 'main_workspace'
      const current = storeFor(keysFor(surface)).get()
      return [{ id: 'config', label: uiText('surface.config'), value: structuredClone(current.config) as unknown as WorkspaceViewStateValue, type: 'json' }, { id: 'preset', label: uiText('surface.preset'), value: current.active }, { id: 'centerId', label: uiText('surface.center'), value: view(surface).centerId }]
    }, render: () => <GraphSearch />
  }))
  offs.push(pluginApi.commands.register<EditInput, { updated: string[] }, 'write'>({
    ...({ outputSchema: graphResults['properties-edit'] } as { outputSchema: Record<string, unknown> }),
    id: 'properties-edit', label: 'Graph: Edit properties', labelKey: 'surface.edit', sideEffect: 'write', paletteSafe: false,
    input: { schema: { type: 'object', required: ['subject', 'values'], properties: { subject: { type: 'object' }, values: { type: 'object', properties: { config: { type: 'object' }, preset: { type: 'string' }, centerId: { type: ['string', 'null'] } }, additionalProperties: false } }, additionalProperties: false }, parse: (raw) => {
      const input = raw as EditInput
      if (input?.subject?.pluginId !== 'graphView' || !surfaces.includes(input.subject.surface as typeof surfaces[number]) || !input.values || Object.keys(input.values).some((key) => !['config', 'preset', 'centerId'].includes(key))) throw new Error(uiText('surface.invalid'))
      if (input.values.config !== undefined && (!input.values.config || typeof input.values.config !== 'object' || Array.isArray(input.values.config))) throw new Error(uiText('surface.invalid'))
      return input
    } },
    revision: ({ subject }) => ({ config: storeFor(keysFor(subject.surface)).get(), view: view(subject.surface) }),
    run: async ({ subject, values }) => {
      const validated = await beforeEffect(async () => {
        assertActive()
        return values.centerId !== undefined ? { centerId: await validateCenter(values.centerId, index) } : null
      })
      // Snapshot after the awaited checks so the revert restores exactly what this edit replaces.
      const { store, prior, previousView, config } = beforeEffect(() => {
        assertActive()
        const store = storeFor(keysFor(subject.surface))
        const prior = structuredClone(store.get())
        if (values.preset && !prior.saved.some((preset) => preset.name === values.preset)) throw refuse('GRAPH_PRESET_UNAVAILABLE', uiText('surface.unavailable'))
        return { store, prior, previousView: { ...view(subject.surface) }, config: values.config !== undefined ? mergeConfig(values.config) : undefined }
      })
      const centerId = validated ? validated.centerId : previousView.centerId
      await commitGraphEdit(store, prior, () => {
        if (values.preset !== undefined) store.select(values.preset)
        if (config !== undefined) store.apply(config)
        patchGraphSurface(subject.surface, { centerId })
      }, () => patchGraphSurface(subject.surface, previousView))
      return { value: { updated: Object.keys(values) }, revert: { label: uiText('surface.edit'), run: async () => { await store.restore(prior); patchGraphSurface(subject.surface, previousView) } } }
    }
  }))
  return () => { active = false; offs.forEach((off) => off()); projection.dispose() }
}
