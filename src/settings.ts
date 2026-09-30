import { api } from './runtime'
import type { FilterRule, GraphConfig, SavedGraph } from './types'
import { normalizePaletteValue, paletteRef } from '@valley/plugin-sdk/palette'

/**
 * The global and local graphs persist independent configs + preset lists in the
 * plugin settings, addressed by these key triples. `config` itself is the
 * host's reserved manifest block — never use it as a settings key.
 */
export interface PresetKeys {
  config: string
  saved: string
  active: string
}

export const GLOBAL_KEYS: PresetKeys = {
  config: 'graphConfig',
  saved: 'savedGraphs',
  active: 'activeGraph'
}

export const LOCAL_KEYS: PresetKeys = {
  config: 'localGraphConfig',
  saved: 'savedLocalGraphs',
  active: 'activeLocalGraph'
}

export const DEFAULT_CONFIG: GraphConfig = {
  plugins: {},
  sourceColors: {
    tags: paletteRef('blue'),
    attachments: paletteRef('amber'),
    orphans: paletteRef('gray'),
    plugins: {}
  },
  filters: { rules: [], showTags: false, showAttachments: false, showOrphans: true, existingOnly: false },
  colorGroups: [],
  display: { showArrows: false, nodeSize: 1.2, linkThickness: 0.7, textFade: 0.2, showLegend: false },
  forces: { center: 0.4, repel: 1.3, link: 0.5, linkDistance: 135 },
  localDepth: 1
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function steppedNumber(value: unknown, fallback: number, min: number, max: number, step: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const clamped = Math.min(max, Math.max(min, numeric))
  return Number((min + Math.round((clamped - min) / step + 1e-9) * step).toFixed(10))
}

/**
 * Filter rows, from either shape: the current `rules` array, or the single
 * `query` string every config written before 1.3 stored — that one becomes one
 * include row, so an upgrade never silently drops a filter.
 */
function mergeRules(f: Record<string, unknown>): FilterRule[] {
  if (Array.isArray(f.rules)) {
    return f.rules.filter(isRecord).map((r, i) => ({
      id: typeof r.id === 'string' ? r.id : `f${i}`,
      query: typeof r.query === 'string' ? r.query : '',
      exclude: r.exclude === true
    }))
  }
  if (typeof f.query === 'string' && f.query.trim()) {
    return [{ id: 'f0', query: f.query, exclude: false }]
  }
  return []
}

/** Merge a stored partial config over the defaults. */
export function mergeConfig(raw: unknown): GraphConfig {
  if (!isRecord(raw)) return { ...DEFAULT_CONFIG }
  const d = DEFAULT_CONFIG
  const f = isRecord(raw.filters) ? raw.filters : {}
  const sourceColors = isRecord(raw.sourceColors) ? raw.sourceColors : {}
  const pluginColors = isRecord(sourceColors.plugins) ? sourceColors.plugins : {}
  const disp = isRecord(raw.display) ? raw.display : {}
  const force = isRecord(raw.forces) ? raw.forces : {}
  return {
    plugins: isRecord(raw.plugins)
      ? Object.fromEntries(Object.entries(raw.plugins).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean').sort(([a], [b]) => a.localeCompare(b)))
      : {},
    sourceColors: {
      tags: normalizePaletteValue(sourceColors.tags) ?? d.sourceColors.tags,
      attachments: normalizePaletteValue(sourceColors.attachments) ?? d.sourceColors.attachments,
      orphans: normalizePaletteValue(sourceColors.orphans) ?? d.sourceColors.orphans,
      plugins: Object.fromEntries(Object.entries(pluginColors)
        .map(([id, color]) => [id, normalizePaletteValue(color)] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .sort(([a], [b]) => a.localeCompare(b)))
    },
    filters: {
      rules: mergeRules(f),
      showTags: typeof f.showTags === 'boolean' ? f.showTags : d.filters.showTags,
      showAttachments: typeof f.showAttachments === 'boolean' ? f.showAttachments : d.filters.showAttachments,
      showOrphans: typeof f.showOrphans === 'boolean' ? f.showOrphans : d.filters.showOrphans,
      existingOnly: typeof f.existingOnly === 'boolean' ? f.existingOnly : d.filters.existingOnly
    },
    colorGroups: Array.isArray(raw.colorGroups)
      ? raw.colorGroups
          .filter(isRecord)
          .map((g, i) => ({
            id: typeof g.id === 'string' ? g.id : `g${i}`,
            query: typeof g.query === 'string' ? g.query : '',
            color: normalizePaletteValue(g.color) ?? paletteRef('violet')
          }))
      : d.colorGroups,
    display: {
      showArrows: typeof disp.showArrows === 'boolean' ? disp.showArrows : d.display.showArrows,
      nodeSize: steppedNumber(disp.nodeSize, d.display.nodeSize, 0.4, 3, 0.1),
      linkThickness: steppedNumber(disp.linkThickness, d.display.linkThickness, 0.4, 3, 0.1),
      textFade: steppedNumber(disp.textFade, d.display.textFade, 0.1, 2, 0.1),
      showLegend: typeof disp.showLegend === 'boolean' ? disp.showLegend : d.display.showLegend
    },
    forces: {
      center: steppedNumber(force.center, d.forces.center, 0, 3, 0.1),
      repel: steppedNumber(force.repel, d.forces.repel, 0.1, 3, 0.1),
      link: steppedNumber(force.link, d.forces.link, 0.1, 3, 0.1),
      linkDistance: steppedNumber(force.linkDistance, d.forces.linkDistance, 20, 200, 5)
    },
    localDepth: steppedNumber(raw.localDepth, d.localDepth, 1, 10, 1)
  }
}

/** Stable deep equality for configs (mergeConfig output has a fixed key order). */
export function configEquals(a: GraphConfig, b: GraphConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function readConfig(keys: PresetKeys): GraphConfig {
  const all = api.settings.get()
  return mergeConfig(all[keys.config])
}

export function readSavedGraphs(keys: PresetKeys): SavedGraph[] {
  const raw = api.settings.get()[keys.saved]
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).map((g) => ({ ...mergeConfig(g), name: typeof g.name === 'string' ? g.name : 'Untitled' }))
}

/** Pinned node positions live beside (not inside) the config, so saving or
 *  loading a preset never snapshots pins. */
export const pinsKeyFor = (keys: PresetKeys): string =>
  keys === LOCAL_KEYS ? 'localGraphPins' : 'graphPins'

export type GraphPins = Record<string, { x: number; y: number }>

export function readPins(keys: PresetKeys): GraphPins {
  const raw = api.settings.get()[pinsKeyFor(keys)]
  if (!isRecord(raw)) return {}
  const out: GraphPins = {}
  for (const [id, pos] of Object.entries(raw)) {
    if (isRecord(pos) && typeof pos.x === 'number' && typeof pos.y === 'number') {
      out[id] = { x: pos.x, y: pos.y }
    }
  }
  return out
}

export function writePins(keys: PresetKeys, pins: GraphPins): void {
  void api.settings.set(pinsKeyFor(keys), pins as unknown as Record<string, unknown>)
}

export function readActiveGraph(keys: PresetKeys): string {
  const raw = api.settings.get()[keys.active]
  return typeof raw === 'string' ? raw : ''
}
