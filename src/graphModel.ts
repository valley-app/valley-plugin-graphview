import type { IndexEntry } from '@valley/plugin-sdk/types'
import { noteDocumentId, parseNoteDocumentId, type NoteDocument, type NoteDocumentSource } from '@valley/plugin-sdk'
import type { ColorGroup, FilterState, GraphData, GraphEdge, GraphNode, SourceColorState } from './types'
import { hasLiveRules, queryMatcher, rulesMatcher } from './filters'
import { paletteRef, runtimePaletteSnapshot } from '@valley/plugin-sdk/palette'

export function graphPluginSources(sources: readonly NoteDocumentSource[]): NoteDocumentSource[] {
  return [...new Map(sources.map(source => [source.pluginId, source])).values()]
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId, 'en'))
}

export function graphPluginColors(sources: readonly NoteDocumentSource[], overrides: Record<string, string> = {}): Record<string, string> {
  const palette = runtimePaletteSnapshot()
  const colors = palette.families.flatMap(family => palette.colors.filter(color => color.familyId === family.id)).reverse()
  return Object.fromEntries(graphPluginSources(sources).map((source, index) => [
    source.pluginId, overrides[source.pluginId] ?? paletteRef(colors[index % colors.length]?.id ?? 'blue')
  ]))
}

function basename(relPath: string): string {
  const seg = relPath.split('/').pop() ?? relPath
  return seg.replace(/\.[^.]+$/, '').toLowerCase()
}

function makeNode(partial: Omit<GraphNode, 'x' | 'y' | 'vx' | 'vy' | 'degree'>, previous?: GraphNode): GraphNode {
  if (previous) return { ...partial, degree: 0, x: previous.x, y: previous.y, vx: previous.vx, vy: previous.vy, pinned: previous.pinned }
  // deterministic-ish initial spread so the layout doesn't start collapsed
  const a = Math.random() * Math.PI * 2
  const r = 40 + Math.random() * 360
  return { ...partial, degree: 0, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 }
}

/**
 * Build the full graph from the vault index, then apply filters. Edges come from
 * `IndexEntry.links` (lowercased basenames) resolved back to real entries.
 */
function projectGraph(
  entries: IndexEntry[],
  filters: FilterState,
  documents: NoteDocument[] = [],
  plugins: Record<string, boolean> = {},
  colorGroups: ColorGroup[] = [],
  sourceColors: SourceColorState | undefined,
  cache: ProjectionCache,
  pluginColors: Record<string, string>
): GraphData {
  // Resolve a linked basename to a relPath. Prefer notes; first match wins.
  const byKey = new Map<string, string>()
  for (const e of entries) {
    const keys = [basename(e.relPath), e.title.toLowerCase(), e.relPath.toLowerCase()]
    for (const alias of e.aliases ?? []) keys.push(alias.toLowerCase())
    for (const k of keys) {
      if (!k) continue
      if (!byKey.has(k) || e.kind === 'note') byKey.set(k, e.relPath)
    }
  }

  const visibleDocuments = documents.filter((document) => plugins[document.ref.pluginId] !== false)

  const included = (e: IndexEntry): boolean => {
    if (e.kind === 'view' || e.kind === 'other') return false
    if (e.kind === 'asset') return filters.showAttachments
    return true
  }

  const nodes = new Map<string, GraphNode>()
  for (const e of entries) {
    if (!included(e)) continue
    nodes.set(
      e.relPath,
      makeNode({
        id: e.relPath,
        label: e.title || basename(e.relPath),
        kind: e.kind === 'asset' ? 'attachment' : 'note',
        path: e.relPath,
        tags: e.tags ?? [],
        createdAt: e.ctimeMs || e.mtimeMs || undefined
      }, cache.nodes.get(e.relPath))
    )
  }

  const edges: GraphEdge[] = []
  for (const document of visibleDocuments) {
    nodes.set(document.id, makeNode({
      id: document.id,
      label: document.title,
      kind: 'document',
      path: '',
      documentRef: document.ref,
      tags: document.tags,
      createdAt: document.sourcePath ? nodes.get(document.sourcePath)?.createdAt : undefined
    }, cache.nodes.get(document.id)))
  }
  const available = new Set(nodes.keys())
  const invalid = new Set<string>()
  const invalidate = (key: string): void => { for (const id of cache.dependents.get(key) ?? []) invalid.add(id) }
  for (const key of new Set([...cache.byKey.keys(), ...byKey.keys()])) {
    if (cache.byKey.get(key) !== byKey.get(key)) invalidate(`alias:${key}`)
  }
  for (const id of new Set([...cache.available, ...available])) {
    if (cache.available.has(id) !== available.has(id)) invalidate(`node:${id}`)
  }
  const policy = JSON.stringify([filters.existingOnly, plugins])
  if (cache.policy !== policy) for (const id of cache.sources.keys()) invalid.add(id)
  cache.policy = policy
  cache.byKey = byKey
  cache.available = available
  const edgeKeys = new Set<string>()
  const addEdge = (source: string, target: string, edge?: GraphEdge): void => {
    if (source === target) return
    const key = JSON.stringify([source, target])
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(edge ?? { source, target })
    const s = nodes.get(source)
    const t = nodes.get(target)
    if (s) s.degree += 1
    if (t) t.degree += 1
  }

  const linkSources = [
    ...entries.map((entry) => ({ id: entry.relPath, links: entry.links ?? [] })),
    ...visibleDocuments.map((document) => ({ id: document.id, links: document.resolvedLinks ?? document.links }))
  ]
  const retained = new Set<string>()
  for (const source of linkSources) {
    if (!nodes.has(source.id)) continue
    retained.add(source.id)
    let contribution = cache.sources.get(source.id)
    if (!contribution || invalid.has(source.id) || !sameStrings(contribution.links, source.links) || source.links.some(link => link.startsWith('??:'))) {
      dropSource(cache, source.id)
      contribution = { links: [...source.links], dependencies: new Set(), edges: [] }
      for (const link of source.links) {
        const documentRef = parseNoteDocumentId(link)
        if (documentRef && plugins[documentRef.pluginId] === false) continue
        const alias = link.split('#')[0].toLowerCase()
        contribution.dependencies.add(`alias:${alias}`)
        contribution.dependencies.add(`node:${documentRef ? noteDocumentId(documentRef) : link}`)
        const targetPath = documentRef ? noteDocumentId(documentRef) : nodes.has(link) ? link : byKey.get(alias)
        if (targetPath) contribution.dependencies.add(`node:${targetPath}`)
        if (targetPath && nodes.has(targetPath)) {
          contribution.edges.push({ edge: { source: source.id, target: targetPath } })
        } else if (!filters.existingOnly) {
          const id = `??:${link.toLowerCase()}`
          if (!nodes.has(id)) nodes.set(id, makeNode({ id, label: link, kind: 'unresolved', path: '', tags: [] }, cache.nodes.get(id)))
          contribution.edges.push({ edge: { source: source.id, target: id }, unresolved: link })
        }
      }
      cache.sources.set(source.id, contribution)
      for (const key of contribution.dependencies) {
        let dependents = cache.dependents.get(key)
        if (!dependents) { dependents = new Set(); cache.dependents.set(key, dependents) }
        dependents.add(source.id)
      }
    }
    for (const { edge, unresolved } of contribution.edges) {
      if (unresolved !== undefined && !nodes.has(edge.target)) {
        nodes.set(edge.target, makeNode({ id: edge.target, label: unresolved, kind: 'unresolved', path: '', tags: [] }, cache.nodes.get(edge.target)))
      }
      addEdge(edge.source, edge.target, edge)
    }
  }
  for (const id of cache.sources.keys()) if (!retained.has(id)) dropSource(cache, id)
  for (const document of visibleDocuments) {
    if (document.sourcePath && nodes.has(document.sourcePath)) addEdge(document.id, document.sourcePath)
  }

  // Synthetic nodes have no file timestamp. Let them appear beside their
  // earliest dated neighbour during history replay instead of all at the end.
  for (const edge of edges) {
    const source = nodes.get(edge.source)
    const target = nodes.get(edge.target)
    if (!source || !target) continue
    if (!source.createdAt && target.createdAt) source.createdAt = target.createdAt
    if (!target.createdAt && source.createdAt) target.createdAt = source.createdAt
  }

  // Tag nodes: one per distinct tag, edge note → tag.
  if (filters.showTags) {
    for (const source of [...nodes.values()]) {
      for (const tag of source.tags) {
        const id = `tag:${tag.toLowerCase()}`
        if (!nodes.has(id)) {
          nodes.set(id, makeNode({ id, label: `#${tag}`, kind: 'tag', path: '', tags: [tag], createdAt: source.createdAt }, cache.nodes.get(id)))
        } else {
          const node = nodes.get(id)!
          if (source.createdAt && (!node.createdAt || source.createdAt < node.createdAt)) node.createdAt = source.createdAt
        }
        addEdge(source.id, id)
      }
    }
  }

  // Apply the text/tag/path filter rules (keeps a node only if it matches).
  let list = [...nodes.values()]
  if (hasLiveRules(filters.rules)) {
    const matches = rulesMatcher(filters.rules)
    list = list.filter((n) => n.kind === 'tag' || matches(n))
  }

  let kept = new Set(list.map((n) => n.id))
  let finalEdges = edges.filter((e) => kept.has(e.source) && kept.has(e.target))

  // Drop orphans (degree 0 after filtering) unless requested.
  if (!filters.showOrphans) {
    const linked = new Set<string>()
    for (const e of finalEdges) {
      linked.add(e.source)
      linked.add(e.target)
    }
    list = list.filter((n) => linked.has(n.id))
    kept = new Set(list.map((n) => n.id))
    finalEdges = finalEdges.filter((e) => kept.has(e.source) && kept.has(e.target))
  }

  // Recompute degree on the final set.
  for (const n of list) n.degree = 0
  const idx = new Map(list.map((n) => [n.id, n]))
  for (const e of finalEdges) {
    const s = idx.get(e.source)
    const t = idx.get(e.target)
    if (s) s.degree += 1
    if (t) t.degree += 1
  }

  const groupMatchers = colorGroups.filter((group) => group.query.trim()).map((group) => ({ group, matches: queryMatcher(group.query) }))
  for (const node of list) {
    const group = groupMatchers.find(({ matches }) => matches(node))?.group
    if (group) node.color = group.color
    else if (node.kind === 'tag') node.color = sourceColors?.tags
    else if (node.kind === 'attachment') node.color = sourceColors?.attachments
    else if (node.kind === 'document' && node.documentRef) {
      node.color = pluginColors[node.documentRef.pluginId]
    } else if (node.degree === 0) node.color = sourceColors?.orphans
  }

  list = list.map(node => {
    const previous = cache.nodes.get(node.id)
    const result = previous && sameNode(previous, node) ? previous : node
    nodes.set(node.id, result)
    return result
  })
  const previousEdges = new Map(cache.graph.edges.map(edge => [JSON.stringify([edge.source, edge.target]), edge]))
  finalEdges = finalEdges.map(edge => previousEdges.get(JSON.stringify([edge.source, edge.target])) ?? edge)
  cache.nodes = nodes
  if (sameItems(cache.graph.nodes, list) && sameItems(cache.graph.edges, finalEdges)) return cache.graph
  return cache.graph = { nodes: list, edges: finalEdges }
}

interface SourceContribution {
  links: string[]
  dependencies: Set<string>
  edges: { edge: GraphEdge; unresolved?: string }[]
}

interface ProjectionCache {
  nodes: Map<string, GraphNode>
  byKey: Map<string, string>
  available: Set<string>
  sources: Map<string, SourceContribution>
  dependents: Map<string, Set<string>>
  policy: string
  graph: GraphData
}

interface ProjectionInputs {
  settings: string
  entries: { id: string; title: string; kind: IndexEntry['kind']; createdAt?: number; aliases: string[]; tags: string[]; links: string[] }[]
  documents: { id: string; owner: string; ref: string; title: string; sourcePath?: string; tags: string[]; links: string[] }[]
}

const sameItems = <T,>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((value, index) => value === b[index])
const sameStrings = (a: readonly string[], b: readonly string[]): boolean => sameItems(a, b)
const sameNode = (a: GraphNode, b: GraphNode): boolean => a.id === b.id && a.label === b.label && a.kind === b.kind && a.path === b.path
  && a.createdAt === b.createdAt && a.degree === b.degree && a.color === b.color && sameStrings(a.tags, b.tags)
  && (a.documentRef === b.documentRef || Boolean(a.documentRef && b.documentRef && noteDocumentId(a.documentRef) === noteDocumentId(b.documentRef)))

function dropSource(cache: ProjectionCache, id: string): void {
  for (const key of cache.sources.get(id)?.dependencies ?? []) {
    const dependents = cache.dependents.get(key)
    dependents?.delete(id)
    if (!dependents?.size) cache.dependents.delete(key)
  }
  cache.sources.delete(id)
}

export function createGraphProjection() {
  const cache: ProjectionCache = { nodes: new Map(), byKey: new Map(), available: new Set(), sources: new Map(), dependents: new Map(), policy: '', graph: { nodes: [], edges: [] } }
  let inputs: ProjectionInputs | undefined
  return {
    update(entries: IndexEntry[], filters: FilterState, documents: NoteDocument[] = [], plugins: Record<string, boolean> = {}, colorGroups: ColorGroup[] = [], sourceColors?: SourceColorState, sources?: readonly NoteDocumentSource[]): GraphData {
      if (sources) {
        const registered = new Set(sources.map(source => JSON.stringify([source.pluginId, source.sourceId])))
        documents = documents.filter(document => registered.has(JSON.stringify([document.ref.pluginId, document.ref.sourceId])))
      }
      const pluginColors = graphPluginColors(sources ?? documents.map(document => ({ pluginId: document.ref.pluginId, sourceId: document.ref.sourceId, label: document.ref.pluginId })), sourceColors?.plugins)
      const settings = JSON.stringify([filters, plugins, colorGroups, sourceColors, pluginColors])
      if (inputs?.settings === settings && inputs.entries.length === entries.length && inputs.documents.length === documents.length
        && entries.every((entry, index) => {
          const previous = inputs!.entries[index]
          return previous.id === entry.relPath && previous.title === entry.title && previous.kind === entry.kind
            && previous.createdAt === (entry.ctimeMs || entry.mtimeMs || undefined) && sameStrings(previous.aliases, entry.aliases ?? [])
            && sameStrings(previous.tags, entry.tags ?? []) && sameStrings(previous.links, entry.links ?? [])
        }) && documents.every((document, index) => {
          const previous = inputs!.documents[index]
          return previous.id === document.id && previous.owner === document.ref.pluginId && previous.ref === noteDocumentId(document.ref)
            && previous.title === document.title && previous.sourcePath === document.sourcePath
            && sameStrings(previous.tags, document.tags) && sameStrings(previous.links, document.resolvedLinks ?? document.links)
        })) return cache.graph
      const nextInputs = {
        settings,
        entries: entries.map(entry => ({ id: entry.relPath, title: entry.title, kind: entry.kind, createdAt: entry.ctimeMs || entry.mtimeMs || undefined, aliases: [...entry.aliases ?? []], tags: [...entry.tags ?? []], links: [...entry.links ?? []] })),
        documents: documents.map(document => ({ id: document.id, owner: document.ref.pluginId, ref: noteDocumentId(document.ref), title: document.title, sourcePath: document.sourcePath, tags: [...document.tags], links: [...document.resolvedLinks ?? document.links] }))
      }
      const graph = projectGraph(entries, filters, documents, plugins, colorGroups, sourceColors, cache, pluginColors)
      inputs = nextInputs
      return graph
    },
    dispose(): void {
      inputs = undefined
      cache.nodes.clear(); cache.byKey.clear(); cache.available.clear(); cache.sources.clear(); cache.dependents.clear()
      cache.policy = ''
      cache.graph = { nodes: [], edges: [] }
    }
  }
}

export function buildGraph(entries: IndexEntry[], filters: FilterState, documents: NoteDocument[] = [], plugins: Record<string, boolean> = {}, colorGroups: ColorGroup[] = [], sourceColors?: SourceColorState, sources?: readonly NoteDocumentSource[]): GraphData {
  return createGraphProjection().update(entries, filters, documents, plugins, colorGroups, sourceColors, sources)
}

/** Restrict a graph to nodes within `depth` hops of `centerId` (undirected). */
export function localSubgraph(full: GraphData, centerId: string, depth: number): GraphData {
  if (!full.nodes.some((n) => n.id === centerId)) return { nodes: [], edges: [] }
  const adj = new Map<string, Set<string>>()
  for (const e of full.edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set())
    if (!adj.has(e.target)) adj.set(e.target, new Set())
    adj.get(e.source)!.add(e.target)
    adj.get(e.target)!.add(e.source)
  }
  const keep = new Set<string>([centerId])
  let frontier = [centerId]
  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!keep.has(nb)) {
          keep.add(nb)
          next.push(nb)
        }
      }
    }
    frontier = next
  }
  const nodes = full.nodes.filter((n) => keep.has(n.id))
  const edges = full.edges.filter((e) => keep.has(e.source) && keep.has(e.target))
  return { nodes, edges }
}

/** Nodes whose label contains `query`: exact names first, then prefixes, then hubs. */
export function findMatches(data: GraphData, query: string): string[] {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return []
  const rank = (label: string): number => (label === wanted ? 0 : label.startsWith(wanted) ? 1 : 2)
  return data.nodes
    .filter((node) => node.label.toLowerCase().includes(wanted))
    .sort((a, b) => rank(a.label.toLowerCase()) - rank(b.label.toLowerCase()) || b.degree - a.degree || a.label.localeCompare(b.label))
    .map((node) => node.id)
}
