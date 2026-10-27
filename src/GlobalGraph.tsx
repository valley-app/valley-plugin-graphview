import { React, api } from './runtime'
import type { NoteDocumentSource } from '@valley/plugin-sdk'
import { readPaletteColor } from '@valley/plugin-sdk/palette'
import { findMatches, graphPluginColors, graphPluginSources } from './graphModel'
export { findMatches } from './graphModel'
import { GraphCanvas } from './GraphCanvas'
import { GraphControls } from './GraphControls'
import { GraphNameBar } from './PresetBar'
import { GraphTabHeader } from './GraphTabHeader'
import { useGraphPresets } from './presets'
import { useGraphProjection, useIndexEntries, useNoteDocuments } from './useGraph'
import { GLOBAL_KEYS, readPins, writePins, type GraphPins, type PresetKeys } from './settings'
import type { GraphConfig, GraphData } from './types'
import { uiText } from './localization'
import { patchGraphSurface, useGraphSurface } from './surfaces'

/** Pinned-position state persisted beside the graph config. */
export function usePins(keys: PresetKeys): {
  pins: GraphPins
  togglePin: (id: string, pos: { x: number; y: number } | null) => void
  unpinAll: () => void
} {
  const [pins, setPins] = React.useState<GraphPins>(() => readPins(keys))
  React.useEffect(() => api.settings.subscribe(() => {
    const next = readPins(keys)
    setPins((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
  }), [keys])
  const togglePin = React.useCallback(
    (id: string, pos: { x: number; y: number } | null): void => {
      setPins((prev) => {
        const next = { ...prev }
        if (pos) next[id] = pos
        else delete next[id]
        writePins(keys, next)
        return next
      })
    },
    [keys]
  )
  const unpinAll = React.useCallback((): void => {
    setPins(() => {
      writePins(keys, {})
      return {}
    })
  }, [keys])
  return { pins, togglePin, unpinAll }
}

/**
 * Left-sidebar panel: settings only — the panel header, the row naming the
 * active saved graph, and the Filters / Color groups / Display controls. The
 * graph itself renders in the workspace tab; both share one store, so changes
 * here update an open tab live.
 *
 * The header is the shared `panel-header`/`panel-title` every left-sidebar
 * panel wears; saved graphs live in the row below it, never in the header.
 */
export const GlobalGraph = (): ReturnType<typeof React.createElement> => {
  const presets = useGraphPresets(GLOBAL_KEYS)
  const { section } = useGraphSurface('left_sidebar')

  return (
    <div className="graphview-panel">
      <div className="panel-header">
        <span className="panel-header-label">
          <span className="panel-title">{uiText('auto.9a7405ebcedd')}</span>
        </span>
        <div className="graphview-panel-actions">
          <button
            className="plugin-open-page"
            onClick={() => api.workspace.openMainTab()}
            aria-label={uiText('auto.25646cefb686')}
            title={uiText('auto.25646cefb686')}
          />
        </div>
      </div>
      <GraphNameBar presets={presets} />
      <div className="graphview-settings">
        <GraphControls
          section={section}
          onSection={(next) => patchGraphSurface('left_sidebar', { section: next ?? section })}
          config={presets.config}
          onChange={presets.apply}
          legend
        />
      </div>
    </div>
  )
}

interface LegendItem { key: string; label: string; color: string }

/** What each color in the graph means: color groups first, then source kinds actually on screen. */
export function legendItems(config: GraphConfig, data: GraphData, sources: readonly NoteDocumentSource[]): LegendItem[] {
  if (!data.nodes.length) return []
  const items: LegendItem[] = config.colorGroups
    .filter((group) => group.query.trim())
    .map((group) => ({ key: `group:${group.id}`, label: group.query.trim(), color: group.color }))
  const shown = (predicate: (node: GraphData['nodes'][number]) => boolean, color: string): boolean =>
    data.nodes.some((node) => predicate(node) && node.color === color)
  if (shown((node) => node.kind === 'tag', config.sourceColors.tags)) items.push({ key: 'tags', label: uiText('auto.848eed0fbd54'), color: config.sourceColors.tags })
  if (shown((node) => node.kind === 'attachment', config.sourceColors.attachments)) items.push({ key: 'attachments', label: uiText('auto.6771ade6e896'), color: config.sourceColors.attachments })
  if (shown((node) => node.degree === 0, config.sourceColors.orphans)) items.push({ key: 'orphans', label: uiText('auto.cb5dc4a4087a'), color: config.sourceColors.orphans })
  const colors = graphPluginColors(sources, config.sourceColors.plugins)
  for (const source of graphPluginSources(sources)) {
    const color = colors[source.pluginId]
    if (shown((node) => node.documentRef?.pluginId === source.pluginId, color)) items.push({ key: `plugin:${source.pluginId}`, label: source.label, color })
  }
  return items
}

/**
 * Main-workspace tab: a name-only header, the full graph,
 * and its legend. Node/link counts live in workspace footer details. Settings live
 * in the left-sidebar panel — one store drives both, so a change there lands
 * here immediately and the canvas stays uncovered.
 */
export const GlobalGraphTab = (): ReturnType<typeof React.createElement> => {
  const entries = useIndexEntries()
  const { documents, sources, error } = useNoteDocuments()
  const presets = useGraphPresets(GLOBAL_KEYS)
  const { pins, togglePin, unpinAll } = usePins(GLOBAL_KEYS)
  const { centerId, animationRun, search, focusId, focusRun } = useGraphSurface('main_workspace')
  const { config } = presets

  const data = useGraphProjection(entries, config.filters, documents, config.plugins, config.colorGroups, config.sourceColors, sources)
  const onOpen = React.useCallback(
    (path: string, newTab?: boolean) => api.workspace.openFile(path, undefined, { newTab }),
    []
  )
  // Centring stays inside the tab — it opens nothing, so it is not a stop on
  // the workspace trail the chevrons walk.
  const onCenter = React.useCallback((id: string) => patchGraphSurface('main_workspace', { centerId: id }), [])

  const query = React.useDeferredValue(search)
  const matches = React.useMemo(() => findMatches(data, query), [data, query])
  const highlightIds = React.useMemo(() => (query.trim() ? new Set(matches) : null), [matches, query])

  const legend = React.useMemo(() => (config.display.showLegend ? legendItems(config, data, sources) : []), [config, data, sources])

  return (
    <div className="graphview-panel graphview-panel-tab">
      <GraphTabHeader name={presets.active} />
      {error && <p role="alert" className="graphview-hint graphview-alert">{uiText('graph.plugins.failed')} {error}</p>}
      <div className="graphview-stage">
        <GraphCanvas
          data={data}
          config={config}
          centerId={centerId}
          onOpen={onOpen}
          onCenter={onCenter}
          pins={pins}
          onTogglePin={togglePin}
          onUnpinAll={unpinAll}
          animationRun={animationRun}
          highlightIds={highlightIds}
          focusId={focusId && data.nodes.some((node) => node.id === focusId) ? focusId : null}
          focusRun={focusRun}
        />
        {legend.length ? (
          <div className="graphview-legend" role="list" aria-label={uiText('graph.legend')}>
            {legend.map((item) => (
              <div className="graphview-legend-item" role="listitem" key={item.key} title={item.label}>
                <span className="graphview-legend-dot" style={{ background: readPaletteColor(item.color) }} />
                <span className="graphview-legend-label">{item.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
