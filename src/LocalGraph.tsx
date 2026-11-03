import { React, api } from './runtime'
import { localSubgraph } from './graphModel'
import { GraphCanvas } from './GraphCanvas'
import { GraphControls } from './GraphControls'
import { GraphNameBar } from './PresetBar'
import { storeFor, useGraphPresets } from './presets'
import { useActivePath, useGraphProjection, useIndexEntries, useNoteDocuments } from './useGraph'
import { GLOBAL_KEYS, LOCAL_KEYS } from './settings'
import { usePins } from './GlobalGraph'
import { uiText } from './localization'
import type { CSSProperties } from 'react'
import { Eye, Filter, LinkDirection } from './icons'
import { patchGraphSurface, useGraphSurface } from './surfaces'

/**
 * Right-sidebar panel: the neighborhood of the active file, with its own
 * config + saved graphs persisted independently of the global graph.
 */
export const LocalGraph = (): ReturnType<typeof React.createElement> => {
  const entries = useIndexEntries()
  const { documents, sources } = useNoteDocuments()
  const currentPath = useActivePath()
  const { centerId, section } = useGraphSurface('right_sidebar')
  const previousPath = React.useRef(currentPath)
  React.useEffect(() => {
    if (previousPath.current !== currentPath) { previousPath.current = currentPath; patchGraphSurface('right_sidebar', { centerId: null }) }
  }, [currentPath])
  const activePath = centerId ?? currentPath
  const presets = useGraphPresets(LOCAL_KEYS)
  const globalPresets = useGraphPresets(GLOBAL_KEYS)
  const choices = {
    ...presets,
    saved: [...globalPresets.saved, ...presets.saved.filter((local) => !globalPresets.saved.some((global) => global.name === local.name))],
    select: (name: string) => storeFor(LOCAL_KEYS).select(name, globalPresets.saved.find((graph) => graph.name === name))
  }
  const { config } = presets
  const localSection = section === 'groups' ? null : section
  const { pins, togglePin, unpinAll } = usePins(LOCAL_KEYS)
  // Collapsed by default: at sidebar width the canvas needs every pixel.

  // The local graph ignores the filter rules; the neighborhood always builds from
  // existing links and orphan-dropping happens implicitly via the BFS.
  const filters = React.useMemo(() => ({ ...config.filters, rules: [], showOrphans: true }), [config.filters])
  const full = useGraphProjection(entries, filters, documents, config.plugins, config.colorGroups, config.sourceColors, sources)
  const data = React.useMemo(
    () => (activePath ? localSubgraph(full, activePath, Math.max(1, config.localDepth)) : { nodes: [], edges: [] }),
    [full, activePath, config.localDepth]
  )

  const onOpen = React.useCallback(
    (path: string, newTab?: boolean) => api.workspace.openFile(path, undefined, { newTab }),
    []
  )

  return (
    <div className="graphview-panel">
      <div className="graphview-local-controls">
        <GraphNameBar presets={choices} selectionOnly actions={(
          <>
            {([{ id: 'filters', Icon: Filter, label: uiText('auto.96e578211aa2') }, { id: 'display', Icon: Eye, label: uiText('auto.574ff9b0c49c') }] as const).map(({ id, Icon, label }) => (
              <button key={id} type="button" className={`graphview-chip${localSection === id ? ' active' : ''}`} aria-label={label} title={label} aria-pressed={localSection === id} onClick={() => patchGraphSurface('right_sidebar', { section: localSection === id ? null : id })}><Icon /></button>
            ))}
          </>
        )} />
        <div className="graphview-depthbar">
          <label htmlFor="graphview-local-depth">{uiText('auto.df0e298e3562')}</label>
          <input id="graphview-local-depth" type="range" className="graphview-slider" min={1} max={10} step={1} value={config.localDepth} style={{ '--slider-fill': `${(config.localDepth - 1) / 9 * 100}%` } as CSSProperties} onChange={(event) => presets.apply({ ...config, localDepth: Number(event.target.value) })} />
          <span className="graphview-value">{config.localDepth}</span>
          <button type="button" className={`graphview-chip${config.display.showArrows ? ' active' : ''}`} aria-label={uiText('auto.0cf604cb001b')} title={uiText('auto.0cf604cb001b')} aria-pressed={config.display.showArrows} onClick={() => presets.apply({ ...config, display: { ...config.display, showArrows: !config.display.showArrows } })}><LinkDirection arrows={config.display.showArrows} /></button>
        </div>
        <GraphControls
          section={localSection}
          onSection={(section) => patchGraphSurface('right_sidebar', { section })}
          config={config}
          onChange={presets.apply}
          hideTabs
          hideArrows
          hideRules
        />
      </div>
      {!activePath ? <div className="graphview-stage"><div className="graphview-empty">{uiText('auto.c9cc088c8d97')}</div></div> : <GraphCanvas
        data={data}
        config={config}
        centerId={activePath}
        centerFit
        onOpen={onOpen}
        pins={pins}
        onTogglePin={togglePin}
        onUnpinAll={unpinAll}
      />}
    </div>
  )
}
