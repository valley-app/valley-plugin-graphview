import { DEFAULT_CONFIG } from '../src/settings'
import { graphPluginColors, graphPluginSources } from '../src/graphModel'
import { runtimePaletteSnapshot, setRuntimePalette } from '@valley/plugin-sdk/palette'
import { describe, expect, it } from 'vitest'
import type { IndexEntry } from '@valley/plugin-sdk/types'
import { buildGraph, createGraphProjection, localSubgraph } from '../src/graphModel'
import { filterCounts, matchQuery } from '../src/filters'
import type { FilterRule, FilterState } from '../src/types'
import { noteDocumentId, type NoteDocument } from '@valley/plugin-sdk'
import { paletteRef } from '@valley/plugin-sdk/palette'

function note(relPath: string, extra: Partial<IndexEntry> = {}): IndexEntry {
  return { relPath, title: relPath.split('/').pop()!.replace(/\.md$/, ''), kind: 'note', mtimeMs: 0, ...extra }
}

function asset(relPath: string): IndexEntry {
  return { relPath, title: relPath.split('/').pop()!, kind: 'asset', mtimeMs: 0 }
}

const rule = (query: string, exclude = false): FilterRule => ({ id: query, query, exclude })

const FILTERS: FilterState = {
  rules: [],
  showTags: false,
  showAttachments: false,
  showOrphans: true,
  existingOnly: false
}

const ids = (g: { nodes: { id: string }[] }): string[] => g.nodes.map((n) => n.id).sort()

function document(pluginId: string, itemId: string, extra: Partial<NoteDocument> = {}): NoteDocument {
  const ref = { pluginId, sourceId: 'items', itemId }
  return { id: noteDocumentId(ref), ref, title: itemId, body: '', tags: [], explicitTags: [], links: [], readOnly: false, revision: 1, realmGeneration: 1, navigation: { command: `${pluginId}:open`, args: { id: itemId } }, ...extra }
}

describe('buildGraph', () => {
  it('includes empty titled documents from every declared owner by default', () => {
    const one = document('fieldwork', 'one')
    const two = document('observations', 'two', { title: 'Same title' })
    const three = document('fieldwork', 'three', { title: 'Same title' })
    const graph = buildGraph([], FILTERS, [one, two, three])
    expect(ids(graph)).toEqual([one.id, two.id, three.id].sort())
    expect(graph.nodes[0]).toMatchObject({ kind: 'document', path: '', documentRef: one.ref })
  })

  it('connects files and documents in both directions with stable ids', () => {
    const item = document('fieldwork', 'one', { links: ['A', 'plugin:observations/items/two'] })
    const other = document('observations', 'two')
    const graph = buildGraph([note('A.md', { links: [item.id] })], FILTERS, [item, other])
    expect(graph.edges).toEqual(expect.arrayContaining([
      { source: 'A.md', target: item.id },
      { source: item.id, target: 'A.md' },
      { source: item.id, target: other.id }
    ]))
    const renamed = buildGraph([note('A.md', { links: [item.id] })], FILTERS, [{ ...item, title: 'Renamed' }])
    expect(renamed.edges).toContainEqual({ source: 'A.md', target: item.id })
  })

  it('hides a disabled owner and incident links without creating unresolved placeholders', () => {
    const item = document('fieldwork', 'one', { sourcePath: 'A.md', tags: ['botanik/äste'] })
    const graph = buildGraph([note('A.md', { links: [item.id] })], { ...FILTERS, showTags: true }, [item], { fieldwork: false })
    expect(ids(graph)).toEqual(['A.md'])
    expect(graph.edges).toEqual([])
  })

  it('adds source-file relationships and unified tags once', () => {
    const item = document('fieldwork', 'one', { links: ['A', 'A'], sourcePath: 'A.md', tags: ['botanik/äste', 'botanik/äste'] })
    const graph = buildGraph([note('A.md', { ctimeMs: 42 })], { ...FILTERS, showTags: true }, [item])
    expect(graph.edges).toEqual([
      { source: item.id, target: 'A.md' },
      { source: item.id, target: 'tag:botanik/äste' }
    ])
    expect(graph.nodes.find((node) => node.id === item.id)?.createdAt).toBe(42)
    expect(graph.nodes.find((node) => node.id === 'tag:botanik/äste')?.createdAt).toBe(42)
    expect(ids(localSubgraph(graph, 'A.md', 1))).toEqual(['A.md', item.id].sort())
  })

  it('preserves unresolved document links until their target becomes available', () => {
    const item = document('fieldwork', 'missing')
    expect(ids(buildGraph([note('A.md', { links: [item.id] })], FILTERS))).toContain(`??:${item.id}`)
    expect(ids(buildGraph([note('A.md', { links: [item.id] })], FILTERS, [item]))).not.toContain(`??:${item.id}`)
  })

  it('resolves links by basename and counts degree', () => {
    const g = buildGraph([note('A.md', { links: ['b'] }), note('sub/B.md')], FILTERS)
    expect(ids(g)).toEqual(['A.md', 'sub/B.md'])
    expect(g.edges).toEqual([{ source: 'A.md', target: 'sub/B.md' }])
    expect(g.nodes.find((n) => n.id === 'A.md')?.degree).toBe(1)
  })

  it('creates unresolved nodes unless existingOnly', () => {
    const entries = [note('A.md', { links: ['ghost'] })]
    expect(ids(buildGraph(entries, FILTERS))).toEqual(['??:ghost', 'A.md'])
    expect(ids(buildGraph(entries, { ...FILTERS, existingOnly: true }))).toEqual(['A.md'])
  })

  it('includes attachments only when showAttachments', () => {
    const entries = [note('A.md'), asset('img.png')]
    expect(ids(buildGraph(entries, FILTERS))).toEqual(['A.md'])
    expect(ids(buildGraph(entries, { ...FILTERS, showAttachments: true }))).toEqual(['A.md', 'img.png'])
  })

  it('adds tag nodes when showTags', () => {
    const g = buildGraph([note('A.md', { tags: ['fungi'] })], { ...FILTERS, showTags: true })
    expect(ids(g)).toEqual(['A.md', 'tag:fungi'])
    expect(g.edges).toEqual([{ source: 'A.md', target: 'tag:fungi' }])
  })

  it('drops orphans when showOrphans is off', () => {
    const entries = [note('A.md', { links: ['b'] }), note('B.md'), note('alone.md')]
    const g = buildGraph(entries, { ...FILTERS, showOrphans: false })
    expect(ids(g)).toEqual(['A.md', 'B.md'])
  })

  it('applies the filter rules to nodes and prunes dangling edges', () => {
    const entries = [note('Fungi/An2.md', { links: ['mech2'] }), note('Fungi/Mech2.md'), note('Plants/BB.md')]
    const g = buildGraph(entries, { ...FILTERS, rules: [rule('path:Fungi/')] })
    expect(ids(g)).toEqual(['Fungi/An2.md', 'Fungi/Mech2.md'])
    expect(g.edges).toHaveLength(1)
  })

  it('ORs include rules and subtracts exclude rules', () => {
    const entries = [note('Fungi/An2.md'), note('Plants/BB.md'), note('Archive/Old.md'), note('Fungi/Draft.md')]
    const both = buildGraph(entries, { ...FILTERS, rules: [rule('path:Fungi/'), rule('path:Plants/')] })
    expect(ids(both)).toEqual(['Fungi/An2.md', 'Fungi/Draft.md', 'Plants/BB.md'])

    const minusDraft = buildGraph(entries, {
      ...FILTERS,
      rules: [rule('path:Fungi/'), rule('path:Plants/'), rule('draft', true)]
    })
    expect(ids(minusDraft)).toEqual(['Fungi/An2.md', 'Plants/BB.md'])

    // Exclude-only: everything survives except the matches.
    const excludeOnly = buildGraph(entries, { ...FILTERS, rules: [rule('path:Archive/', true)] })
    expect(ids(excludeOnly)).toEqual(['Fungi/An2.md', 'Fungi/Draft.md', 'Plants/BB.md'])
  })

  it('ignores a rule with nothing typed in it', () => {
    const entries = [note('Fungi/An2.md'), note('Plants/BB.md')]
    const g = buildGraph(entries, { ...FILTERS, rules: [rule('  ')] })
    expect(ids(g)).toEqual(['Fungi/An2.md', 'Plants/BB.md'])
  })

  it('applies the first matching color group to every matching node kind', () => {
    const item = document('fieldwork', 'fern', { tags: ['canopy'] })
    const graph = buildGraph(
      [note('Fungi/Fern.md', { tags: ['canopy'] }), note('Plants/Moss.md')],
      { ...FILTERS, showTags: true },
      [item],
      {},
      [
        { id: 'canopy', query: 'tag:canopy', color: '#247a52' },
        { id: 'fungi', query: 'path:Fungi/', color: '#873aa6' },
        { id: 'empty', query: '', color: '#c93445' }
      ]
    )
    expect(graph.nodes.find((node) => node.id === 'Fungi/Fern.md')?.color).toBe('#247a52')
    expect(graph.nodes.find((node) => node.id === item.id)?.color).toBe('#247a52')
    expect(graph.nodes.find((node) => node.id === 'tag:canopy')?.color).toBe('#247a52')
    expect(graph.nodes.find((node) => node.id === 'Plants/Moss.md')?.color).toBeUndefined()
  })

  it('colors tags, attachments, orphans and plugin documents below query groups', () => {
    const item = document('fieldwork', 'fern')
    const graph = buildGraph(
      [note('Linked.md', { links: ['target'], tags: ['canopy'] }), note('Target.md'), note('Alone.md'), asset('photo.png')],
      { ...FILTERS, showTags: true, showAttachments: true },
      [item],
      {},
      [{ id: 'group', query: 'target', color: paletteRef('violet') }],
      {
        tags: paletteRef('blue'),
        attachments: paletteRef('amber'),
        orphans: paletteRef('gray'),
        plugins: { fieldwork: paletteRef('green') }
      }
    )
    expect(graph.nodes.find((node) => node.id === 'tag:canopy')?.color).toBe(paletteRef('blue'))
    expect(graph.nodes.find((node) => node.id === 'photo.png')?.color).toBe(paletteRef('amber'))
    expect(graph.nodes.find((node) => node.id === 'Alone.md')?.color).toBe(paletteRef('gray'))
    expect(graph.nodes.find((node) => node.id === item.id)?.color).toBe(paletteRef('green'))
    expect(graph.nodes.find((node) => node.id === 'Target.md')?.color).toBe(paletteRef('violet'))
  })
})

describe('localSubgraph', () => {
  const chain = buildGraph(
    [note('A.md', { links: ['b'] }), note('B.md', { links: ['c'] }), note('C.md'), note('far.md')],
    FILTERS
  )

  it('returns nodes within depth hops of the center', () => {
    expect(ids(localSubgraph(chain, 'A.md', 1))).toEqual(['A.md', 'B.md'])
    expect(ids(localSubgraph(chain, 'A.md', 2))).toEqual(['A.md', 'B.md', 'C.md'])
  })

  it('returns empty when the center is missing', () => {
    expect(localSubgraph(chain, 'nope.md', 2).nodes).toEqual([])
  })
})

describe('incremental graph projection', () => {
  it('keeps unchanged graph identities and simulation state across equivalent index snapshots', () => {
    const projection = createGraphProjection()
    const entries = [note('Fern.md', { ctimeMs: 10, links: ['Moss'] }), note('Moss.md', { ctimeMs: 10 })]
    const item = document('fieldwork', 'survey', { sourcePath: 'Fern.md' })
    const first = projection.update(entries, FILTERS, [item])
    Object.assign(first.nodes[0], { x: 123, y: 456, vx: 7, vy: 8, pinned: true })
    const same = projection.update(structuredClone(entries).map(entry => ({ ...entry, mtimeMs: 100, frontmatter: { unrelated: true } })), { ...FILTERS }, [{ ...item, revision: 2, body: 'Unrelated body edit' }])
    expect(same).toBe(first)
    expect(same.nodes[0]).toMatchObject({ x: 123, y: 456, vx: 7, vy: 8, pinned: true })
    const renamed = projection.update([{ ...entries[0], title: 'Farn' }, entries[1]], FILTERS, [item])
    expect(renamed.nodes[0]).toMatchObject({ label: 'Farn', x: 123, y: 456, vx: 7, vy: 8, pinned: true })
    expect(renamed.nodes[1]).toBe(first.nodes[1])
    expect(renamed.edges[0]).toBe(first.edges[0])
  })

  it('replaces affected connections while retaining an unrelated component and all existing positions', () => {
    const entries = [note('A.md', { links: ['B'] }), note('B.md'), note('C.md'), note('D.md', { links: ['E'] }), note('E.md')]
    const projection = createGraphProjection()
    const first = projection.update(entries, FILTERS)
    first.nodes.forEach((node, index) => { node.x = index * 70; node.vx = index })
    const next = projection.update([{ ...entries[0], links: ['C'] }, ...entries.slice(1)], FILTERS)
    expect(next.edges).toEqual([{ source: 'A.md', target: 'C.md' }, { source: 'D.md', target: 'E.md' }])
    expect(next.edges[1]).toBe(first.edges[1])
    expect(next.nodes[3]).toBe(first.nodes[3])
    expect(next.nodes.map(node => [node.x, node.vx])).toEqual(first.nodes.map(node => [node.x, node.vx]))
    expect(next.nodes.find(node => node.id === 'B.md')?.degree).toBe(0)
    expect(next.nodes.find(node => node.id === 'C.md')?.degree).toBe(1)
  })

  it('invalidates unchanged link sources when aliases, target precedence, or target existence change', () => {
    const projection = createGraphProjection()
    const source = note('Source.md', { links: ['canopy', 'Missing'] })
    const fern = note('Fern.md', { aliases: ['canopy'] })
    const moss = note('Moss.md', { aliases: ['canopy'] })
    expect(projection.update([source, fern, moss], FILTERS).edges[0].target).toBe('Moss.md')
    expect(projection.update([source, moss, fern], FILTERS).edges[0].target).toBe('Fern.md')
    expect(projection.update([source, { ...fern, aliases: [] }, moss], FILTERS).edges[0].target).toBe('Moss.md')
    const resolved = projection.update([source, note('Missing.md')], FILTERS)
    expect(resolved.edges).toEqual([{ source: 'Source.md', target: '??:canopy' }, { source: 'Source.md', target: 'Missing.md' }])
    expect(ids(resolved)).not.toContain('??:missing')
    const removed = projection.update([source], FILTERS)
    expect(ids(removed)).toEqual(['??:canopy', '??:missing', 'Source.md'])
  })

  it('matches a fresh projection after document, tag, source, attachment, and filter changes', () => {
    const projection = createGraphProjection()
    const entry = note('Fern.md', { links: ['ghost'], tags: ['canopy'], ctimeMs: 5 })
    const item = document('fieldwork', 'survey', { sourcePath: 'Fern.md', links: ['photo.png'], tags: ['canopy'] })
    const states: { entries: IndexEntry[]; documents: NoteDocument[]; filters: FilterState; plugins: Record<string, boolean> }[] = [
      { entries: [entry, asset('photo.png')], documents: [item], filters: { ...FILTERS, showTags: true }, plugins: {} },
      { entries: [entry, asset('photo.png')], documents: [item], filters: { ...FILTERS, showTags: true, showAttachments: true }, plugins: {} },
      { entries: [{ ...entry, links: [], tags: [] }, asset('photo.png')], documents: [{ ...item, sourcePath: undefined, tags: ['wetland'] }], filters: { ...FILTERS, showTags: true, showAttachments: true }, plugins: {} },
      { entries: [entry], documents: [item], filters: { ...FILTERS, showTags: true, showOrphans: false }, plugins: { fieldwork: false } },
      { entries: [entry], documents: [], filters: { ...FILTERS, existingOnly: true, rules: [rule('tag:canopy')] }, plugins: {} },
      { entries: [], documents: [], filters: FILTERS, plugins: {} },
      { entries: [entry], documents: [item], filters: FILTERS, plugins: {} }
    ]
    const metadata = (graph: ReturnType<typeof buildGraph>) => ({
      nodes: graph.nodes.map(({ x: _x, y: _y, vx: _vx, vy: _vy, pinned: _pinned, ...node }) => node),
      edges: graph.edges
    })
    for (const state of states) {
      expect(metadata(projection.update(state.entries, state.filters, state.documents, state.plugins)))
        .toEqual(metadata(buildGraph(state.entries, state.filters, state.documents, state.plugins)))
    }
  })

  it('releases removed synthetic nodes and disposes per-view simulation state', () => {
    const projection = createGraphProjection()
    const entries = [note('A.md', { links: ['ghost'] }), note('B.md', { links: ['ghost'] })]
    const first = projection.update(entries, FILTERS)
    first.nodes[0].x = 9999
    expect(ids(projection.update([entries[1]], FILTERS))).toContain('??:ghost')
    expect(projection.update([], FILTERS)).toEqual({ nodes: [], edges: [] })
    projection.update(entries, FILTERS).nodes[0].x = 8888
    const independent = createGraphProjection().update(entries, FILTERS)
    expect(independent.nodes[0].x).not.toBe(8888)
    projection.dispose()
    expect(projection.update(entries, FILTERS).nodes[0].x).not.toBe(8888)
  })
})

describe('filter queries', () => {
  const target = { label: 'Kickoff', path: 'Projects/Copper Finch/Kickoff.md', tags: ['meeting'] }

  it('keeps quoted values with spaces together and negates quoted terms', () => {
    expect(matchQuery(target, 'path:"Projects/Copper Finch/"')).toBe(true)
    expect(matchQuery(target, 'path:"Projects/Glass Harbor/"')).toBe(false)
    expect(matchQuery(target, '-path:"Projects/Copper Finch/"')).toBe(false)
    expect(matchQuery(target, '"copper finch" tag:#meeting')).toBe(true)
    expect(matchQuery(target, 'path:"Copper Finch/Kick')).toBe(true)
  })

  it('colors a quoted-path group and narrows the base to a quoted folder', () => {
    const entries = [note('Projects/Copper Finch/Kickoff.md', { links: ['notes'] }), note('Projects/Copper Finch/Notes.md'), note('Archive/Other.md')]
    const groups = [{ id: 'g', query: 'path:"Projects/Copper Finch/"', color: paletteRef('green') }]
    const graph = buildGraph(entries, { ...FILTERS, rules: [rule('path:"Projects/Copper Finch/"')] }, [], {}, groups)
    expect(ids(graph)).toEqual(['Projects/Copper Finch/Kickoff.md', 'Projects/Copper Finch/Notes.md'])
    expect(graph.nodes.every((node) => node.color === paletteRef('green'))).toBe(true)
  })

  it('counts the files in the base and what each live exclusion removes', () => {
    const entries = [
      note('Projects/A.md', { tags: ['draft'] }),
      note('Projects/B.md'),
      note('Archive/C.md', { tags: ['draft'] }),
      asset('Projects/photo.png'),
      { relPath: 'Board.canvas', title: 'Board', kind: 'view', mtimeMs: 0 } as IndexEntry
    ]
    const whole = filterCounts(entries, [rule('tag:#draft', true), rule('   ', true)], false)
    expect(whole).toEqual({ base: 3, excluded: { 'tag:#draft': 2 } })
    const narrowed = filterCounts(entries, [rule('path:Projects/'), rule('tag:#draft', true)], true)
    expect(narrowed).toEqual({ base: 3, excluded: { 'tag:#draft': 1 } })
  })
})


it('limits local neighborhoods to ten links from the current file', () => {
  const chain = Array.from({ length: 12 }, (_, i) => note(`Node${i}.md`, { links: i < 11 ? [`Node${i + 1}`] : [] }))
  const full = buildGraph(chain, FILTERS)
  expect(localSubgraph(full, 'Node0.md', 1).nodes.map((node) => node.id)).toEqual(['Node0.md', 'Node1.md'])
  const local = localSubgraph(full, 'Node0.md', 10)
  expect(local.nodes).toHaveLength(11)
  expect(local.edges).toHaveLength(10)
  expect(local.nodes.some((node) => node.id === 'Node11.md')).toBe(false)
})


describe('registered graph sources', () => {
  it('assigns colors from the bottom of the visible palette and cycles after exhaustion', () => {
    const palette = runtimePaletteSnapshot()
    const order = palette.families.flatMap(family => palette.colors.filter(color => color.familyId === family.id)).reverse()
    const sources = Array.from({ length: order.length + 2 }, (_, i) => ({ pluginId: `source-${String(i).padStart(3, '0')}`, sourceId: 'notes', label: 'Source' }))
    const colors = graphPluginColors([...sources].reverse())
    expect(Object.values(colors)).toEqual(sources.map((_, i) => paletteRef(order[i % order.length].id)))
    const reversed = { ...palette, colors: [...palette.colors].reverse() }
    try {
      setRuntimePalette(reversed)
      expect(graphPluginColors(sources)[sources[0].pluginId]).not.toBe(colors[sources[0].pluginId])
    } finally { setRuntimePalette(palette) }
    expect(graphPluginColors(sources, { 'source-000': '#123456' })['source-000']).toBe('#123456')
  })

  it('deduplicates owners and keeps empty or disabled sources in the color sequence', () => {
    const sources = [
      { pluginId: 'fieldwork', sourceId: 'empty', label: 'Fieldwork' },
      { pluginId: 'observations', sourceId: 'items', label: 'Observations' },
      { pluginId: 'observations', sourceId: 'archive', label: 'Observations' }
    ]
    expect(graphPluginSources(sources)).toHaveLength(2)
    const item = document('observations', 'one')
    const graph = buildGraph([], FILTERS, [item], { fieldwork: false }, [], DEFAULT_CONFIG.sourceColors, sources)
    expect(graph.nodes.find(node => node.id === item.id)?.color).toBe(graphPluginColors(sources).observations)
    expect(buildGraph([], FILTERS, [item], {}, [], undefined, []).nodes).toEqual([])
  })
})
