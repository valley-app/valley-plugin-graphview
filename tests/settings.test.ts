import { describe, expect, it } from 'vitest'
import { paletteRef } from '@valley/plugin-sdk/palette'
import { DEFAULT_CONFIG, configEquals, mergeConfig } from '../src/settings'

describe('mergeConfig', () => {
  it('enables unconfigured plugins while preserving explicit owner switches', () => {
    expect(mergeConfig({}).plugins).toEqual({})
    expect(mergeConfig({ plugins: { fieldwork: false, observations: true, invalid: 'false' } }).plugins)
      .toEqual({ fieldwork: false, observations: true })
    const first = mergeConfig({ plugins: { observations: true, fieldwork: false } })
    const second = mergeConfig({ plugins: { fieldwork: false, observations: true } })
    expect(configEquals(first, second)).toBe(true)
    expect(configEquals(first, mergeConfig({ plugins: { fieldwork: true, observations: true } }))).toBe(false)
  })
  it('falls back to defaults for garbage input', () => {
    expect(mergeConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(mergeConfig('nope')).toEqual(DEFAULT_CONFIG)
    expect(mergeConfig([])).toEqual(DEFAULT_CONFIG)
  })

  it('keeps valid fields and fills the rest', () => {
    const merged = mergeConfig({
      filters: { rules: [{ id: 'f1', query: 'tag:#x', exclude: true }], showTags: true },
      display: { nodeSize: 2 },
      localDepth: 3
    })
    expect(merged.filters.rules).toEqual([{ id: 'f1', query: 'tag:#x', exclude: true }])
    expect(merged.filters.showTags).toBe(true)
    expect(merged.filters.showOrphans).toBe(DEFAULT_CONFIG.filters.showOrphans)
    expect(merged.display.nodeSize).toBe(2)
    expect(merged.display.showArrows).toBe(false)
    expect(merged.display.showLegend).toBe(false)
    expect(mergeConfig({ display: { showLegend: false } }).display.showLegend).toBe(false)
    expect(mergeConfig({ display: { showLegend: 'no' } }).display.showLegend).toBe(false)
    expect(merged.forces).toEqual(DEFAULT_CONFIG.forces)
    expect(merged.localDepth).toBe(3)
    expect(mergeConfig({ localDepth: 10 }).localDepth).toBe(10)
    expect(mergeConfig({ localDepth: 99 }).localDepth).toBe(10)
    expect(mergeConfig({ localDepth: 0 }).localDepth).toBe(1)
  })

  it('fills the link distance a pre-1.2 config never stored', () => {
    const merged = mergeConfig({ forces: { center: 2, repel: 0.5, link: 1 } })
    expect(merged.forces.center).toBe(2)
    expect(merged.forces.linkDistance).toBe(DEFAULT_CONFIG.forces.linkDistance)
  })

  it('clamps and snaps stored control values to the rendered slider steps', () => {
    const merged = mergeConfig({
      display: { textFade: -2, nodeSize: 9, linkThickness: 0.85 },
      forces: { center: 0.04, repel: Number.NaN, link: 1.26, linkDistance: 113 },
      localDepth: 2.7
    })
    expect(merged.display).toMatchObject({ textFade: 0.1, nodeSize: 3, linkThickness: 0.9 })
    expect(merged.forces).toEqual({ center: 0, repel: 1.3, link: 1.3, linkDistance: 115 })
    expect(merged.localDepth).toBe(3)
  })

  it('carries a pre-1.3 single query over as one include rule', () => {
    expect(mergeConfig({ filters: { query: 'path:Fungi/' } }).filters.rules).toEqual([
      { id: 'f0', query: 'path:Fungi/', exclude: false }
    ])
    expect(mergeConfig({ filters: { query: '' } }).filters.rules).toEqual([])
    expect(mergeConfig({ filters: { query: '   ' } }).filters.rules).toEqual([])
  })

  it('normalizes filter rules', () => {
    const merged = mergeConfig({
      filters: { rules: [{ query: 'a' }, 'junk', { id: 'f9', exclude: 'yes' }, { id: 'f8', exclude: true }] }
    })
    expect(merged.filters.rules).toEqual([
      { id: 'f0', query: 'a', exclude: false },
      { id: 'f9', query: '', exclude: false },
      { id: 'f8', query: '', exclude: true }
    ])
  })

  it('normalizes color groups', () => {
    // `#fff` is not a valid stored colour (six digits or a palette ref), so it
    // falls back rather than reaching the DOM as a value nothing can resolve.
    const merged = mergeConfig({ colorGroups: [{ query: 'path:Fungi' }, 'junk', { id: 'g9', color: '#fff' }] })
    expect(merged.colorGroups).toEqual([
      { id: 'g0', query: 'path:Fungi', color: paletteRef('violet') },
      { id: 'g9', query: '', color: paletteRef('violet') }
    ])
  })

  it('normalizes source and plugin colors independently', () => {
    const merged = mergeConfig({
      sourceColors: {
        tags: '#247A52',
        attachments: 'palette:orange',
        orphans: '#fff',
        plugins: { observations: 'palette:cyan', fieldwork: '#C93445', invalid: 'red' }
      }
    })
    expect(merged.sourceColors).toEqual({
      tags: '#247a52',
      attachments: paletteRef('orange'),
      orphans: DEFAULT_CONFIG.sourceColors.orphans,
      plugins: { fieldwork: '#c93445', observations: paletteRef('cyan') }
    })
  })
})

describe('configEquals', () => {
  it('is true for merge-normalized clones and false after a change', () => {
    const a = mergeConfig({ display: { nodeSize: 1.5 } })
    const b = mergeConfig(JSON.parse(JSON.stringify(a)))
    expect(configEquals(a, b)).toBe(true)
    expect(configEquals(a, { ...b, display: { ...b.display, nodeSize: 2 } })).toBe(false)
  })
})


it('uses the requested display and force defaults for every new graph', () => {
  expect(mergeConfig({}).display).toEqual({ showArrows: false, showLegend: false, textFade: 0.2, nodeSize: 1.2, linkThickness: 0.7 })
  expect(mergeConfig({}).forces).toEqual({ center: 0.4, repel: 1.3, link: 0.5, linkDistance: 135 })
  expect(mergeConfig({ display: { showLegend: true, nodeSize: 2 }, forces: { linkDistance: 80 } })).toMatchObject({ display: { showLegend: true, nodeSize: 2 }, forces: { linkDistance: 80 } })
})
