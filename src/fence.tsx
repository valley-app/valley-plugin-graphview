/**
 * ```graph``` code block — a live knowledge-graph excerpt in a note.
 *
 *   ```graph
 *   ```                    → local graph of the current note
 *   ```graph
 *   of: [[Fungi Survey]]    → local graph of another note (path or wikilink)
 *   depth: 2
 *   height: 320
 *   ```
 *   ```graph
 *   global: true           → the whole vault graph
 *   query: habitats             → filtered like the global graph's search
 *   ```
 *
 * The canvas mounts lazily (viewport-visible) and clicking a node opens the file.
 */
import codeBlockExamples from './codeBlockExamples.json'
import { React, api } from './runtime'
import type { FC } from 'react'
import { fenceInt, parseFenceParams } from '@valley/plugin-sdk/fenceParams'
import { localSubgraph } from './graphModel'
import { GraphCanvas } from './GraphCanvas'
import { DEFAULT_CONFIG } from './settings'
import { useGraphProjection, useIndexEntries, useNoteDocuments } from './useGraph'
import { uiText } from './localization'
import { getGraphIndex } from './indexOwner'

const STYLE_ID = 'notes-graph-fence-styles'

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.graph-fence { position: relative; margin: 0.75em 0; border: 1px solid var(--border-light); border-radius: var(--radius); background: var(--container-color); overflow: hidden; }
.graph-fence-inner { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; }
.graph-fence-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary); font-size: var(--small-font-size); }
`
  document.head.appendChild(style)
}

const GraphFence: FC<{ code: string; path: string | null }> = ({ code, path }) => {
  const [owner] = React.useState(() => getGraphIndex(api))
  const entries = useIndexEntries()
  const { documents, sources } = useNoteDocuments()
  const hostRef = React.useRef<HTMLDivElement>(null)
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const io = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '120px' }
    )
    io.observe(host)
    return () => io.disconnect()
  }, [])

  const params = parseFenceParams(code)
  const global = (params.values.global ?? '').toLowerCase() === 'true'
  const depth = fenceInt(params, 'depth', 6) ?? DEFAULT_CONFIG.localDepth
  const query = params.values.query ?? ''
  const ofRef = params.values.of ?? params.bare
  const wanted = ofRef ? ofRef.replace(/^\[\[/, '').replace(/\]\]$/, '') : null
  const centerId = global ? null : wanted ? owner.resolve(wanted) ?? wanted : path

  const config = React.useMemo(() => ({ ...DEFAULT_CONFIG, localDepth: depth }), [depth])
  const filters = React.useMemo(
    () => ({
        ...config.filters,
        rules: global && query ? [{ id: 'f0', query, exclude: false }] : [],
        showOrphans: !global
      }),
    [config.filters, global, query]
  )
  const full = useGraphProjection(entries, filters, documents, config.plugins, config.colorGroups, config.sourceColors, sources)
  const data = React.useMemo(() => {
    if (global) return full
    if (!centerId) return { nodes: [], edges: [] }
    return localSubgraph(full, centerId, Math.max(1, depth))
  }, [full, global, centerId, depth])

  const onOpen = React.useCallback(
    (relPath: string, newTab?: boolean) => { owner.assertCurrent(); owner.api.workspace.openFile(relPath, undefined, { newTab }) },
    [owner]
  )

  let body: JSX.Element
  if (!global && !centerId) {
    body = <div className="graph-fence-empty">{uiText('auto.acfc805f8a9f')}</div>
  } else if (data.nodes.length === 0) {
    body = <div className="graph-fence-empty">{uiText('auto.7970105becd2')}</div>
  } else if (!visible) {
    body = <div className="graph-fence-empty">{uiText('auto.b60ca727a5e5')}</div>
  } else {
    body = <GraphCanvas data={data} config={config} centerId={global ? undefined : centerId ?? undefined} centerFit={!global} onOpen={onOpen} />
  }

  return (
    <div ref={hostRef} className="graph-fence-inner">
      {body}
    </div>
  )
}

/** Register the ```graph``` fence; returns the unregister fn. */
export function registerGraphFence(): () => void {
  const off = api.markdown.registerCodeBlockRenderer('graph', (code, el, ctx) => {
    ensureStyles()
    el.classList.add('graph-fence')
    const params = parseFenceParams(code)
    const height = fenceInt(params, 'height', 800) ?? 280
    el.style.height = `${height}px`
    return api.ui.renderReact(el, <GraphFence code={code} path={ctx.path} />)
  }, { examples: codeBlockExamples.graph })
  return () => {
    off()
    document.getElementById(STYLE_ID)?.remove()
  }
}
