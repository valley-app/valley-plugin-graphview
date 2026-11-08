import { React, api } from './runtime'
import type { GraphConfig, SavedGraph } from './types'
import {
  type PresetKeys,
  DEFAULT_CONFIG,
  readActiveGraph,
  readConfig,
  mergeConfig,
  readSavedGraphs
} from './settings'
import { uiText } from './localization'

export interface GraphPresets {
  config: GraphConfig
  /** Set the live config; it saves into the active graph. */
  apply: (next: GraphConfig) => void
  saved: SavedGraph[]
  /** Name of the active saved graph ('' = the Default graph). */
  active: string
  select: (name: string) => void
  /** Localized reason a name cannot be used, or '' when it can. */
  nameError: (name: string, renaming?: boolean) => string
  /** New whole-realm graph, selected. Undoable. */
  create: (name: string) => boolean
  /** Copy of the active graph under a new name, selected. Undoable. */
  duplicate: (name: string) => boolean
  /** Rename the active graph; naming the Default graph saves it and resets Default. Undoable. */
  rename: (next: string) => boolean
  /** Delete the active named graph and fall back to Default. Undoable. */
  remove: () => void
}

const stripName = (preset: SavedGraph): GraphConfig => {
  const { name: _omit, ...config } = preset
  return config
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

const freshConfig = (): GraphConfig => structuredClone(DEFAULT_CONFIG)

export interface StoreState {
  /** Live config of the active graph. */
  config: GraphConfig
  saved: SavedGraph[]
  active: string
  /** Config of the Default graph, which exists in every realm. */
  defaultConfig: GraphConfig
}

/** Trailing debounce for config writes — see {@link PresetStore.apply}. */
const CONFIG_WRITE_DELAY_MS = 400

/**
 * Module-level store, one per key-set, shared by every view of this plugin in
 * the window — so a settings change in the sidebar panel updates an open graph
 * tab instantly. (The host's persisted-settings snapshot refreshes async, so it
 * can't be the within-session source of truth.)
 *
 * Every graph saves itself: edits land in the active saved graph, or in the
 * Default graph (`keys.config`) when no named graph is active. Writes persist
 * through `api.settings.*` for the next session.
 */
export class PresetStore {
  private state: StoreState | null = null
  private listeners = new Set<() => void>()
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private scheduled = new Set<string>()
  private settings = api.settings
  private dirty = new Map<string, unknown>()
  private pending = new Set<Promise<void>>()
  private writing = new Map<string, number>()
  private failures = new Map<string, Error>()

  constructor(private keys: PresetKeys) {
    api.runtime.onBeforeUnload(() => this.flushBeforeUnload())
  }

  private persist(key: string, value: unknown): void {
    this.dirty.set(key, value)
    this.failures.delete(key)
    this.writing.set(key, (this.writing.get(key) ?? 0) + 1)
    const pending = this.settings.set(key, value).then((result) => {
      if (!result.ok) throw new Error('Graph settings could not be saved.')
      if (this.dirty.get(key) === value) this.dirty.delete(key)
    }).catch((error: unknown) => {
      if (this.dirty.get(key) === value) this.failures.set(key, error instanceof Error ? error : new Error(String(error)))
    }).finally(() => {
      this.pending.delete(pending)
      const remaining = (this.writing.get(key) ?? 1) - 1
      if (remaining) this.writing.set(key, remaining)
      else this.writing.delete(key)
    })
    this.pending.add(pending)
  }

  private valueOf(key: string): unknown {
    const state = this.get()
    if (key === this.keys.saved) return state.saved
    if (key === this.keys.active) return state.active
    return state.defaultConfig
  }

  private async flushBeforeUnload(): Promise<void> {
    this.flush()
    for (const [key, value] of this.dirty) if (!this.writing.has(key)) this.persist(key, value)
    do {
      await Promise.all(this.pending)
      this.flush()
    } while (this.pending.size)
    if (this.dirty.size) throw this.failures.values().next().value ?? new Error('Graph settings could not be saved.')
  }

  get(): StoreState {
    if (!this.state) {
      const saved = readSavedGraphs(this.keys)
      const defaultConfig = readConfig(this.keys)
      const stored = readActiveGraph(this.keys)
      const preset = stored ? saved.find((s) => s.name === stored) : undefined
      this.state = { saved, defaultConfig, active: preset ? stored : '', config: preset ? stripName(preset) : defaultConfig }
    }
    return this.state
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<StoreState>): void {
    this.state = { ...this.get(), ...patch }
    this.listeners.forEach((listener) => listener())
  }

  /** Persist the given keys now, after any debounce-pending write. */
  private write(...keys: string[]): void {
    this.flush()
    for (const key of keys) this.persist(key, this.valueOf(key))
  }

  /**
   * Update the live config: in-memory + listeners fire instantly, but the disk
   * write is debounced so slider movement does not flood settings persistence
   * and reload events.
   */
  apply(config: GraphConfig): void {
    const { active, saved } = this.get()
    if (active) this.set({ config, saved: saved.map((s) => (s.name === active ? { ...config, name: active } : s)) })
    else this.set({ config, defaultConfig: config })
    this.scheduled.add(active ? this.keys.saved : this.keys.config)
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.persistScheduled()
    }, CONFIG_WRITE_DELAY_MS)
  }

  private persistScheduled(): void {
    const keys = [...this.scheduled]
    this.scheduled.clear()
    for (const key of keys) this.persist(key, this.valueOf(key))
  }

  /** Write any debounce-pending config now (ordering before other writes). */
  flush(): void {
    if (!this.writeTimer) return
    clearTimeout(this.writeTimer)
    this.writeTimer = null
    this.persistScheduled()
  }

  async commit(): Promise<void> {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null }
    this.scheduled.clear()
    for (const key of [this.keys.config, this.keys.saved, this.keys.active]) this.persist(key, this.valueOf(key))
    await this.flushBeforeUnload()
  }

  async restore(state: StoreState): Promise<void> {
    this.set(structuredClone(state))
    await this.commit()
  }

  /** Localized reason `name` cannot name a graph, or ''. Renaming a graph to its own name is fine. */
  nameError(name: string, current = this.get().active): string {
    const trimmed = name.trim()
    if (!trimmed) return uiText('graph.name.empty')
    return this.get().saved.some((s) => sameName(s.name, trimmed) && s.name !== current) ? uiText('graph.name.taken') : ''
  }

  select(name: string, initialConfig?: GraphConfig): void {
    const { saved, defaultConfig } = this.get()
    const preset = name ? saved.find((s) => s.name === name) : undefined
    if (name && !preset) {
      if (initialConfig) this.add(name, mergeConfig(initialConfig))
      return
    }
    this.flush()
    this.set({ active: preset ? name : '', config: preset ? stripName(preset) : defaultConfig })
    this.write(this.keys.active)
  }

  private add(name: string, config: GraphConfig): boolean {
    const trimmed = name.trim()
    if (this.nameError(trimmed, '')) return false
    this.flush()
    this.set({ saved: [...this.get().saved, { ...config, name: trimmed }], active: trimmed, config })
    this.write(this.keys.saved, this.keys.active)
    return true
  }

  create(name: string): boolean {
    return this.add(name, freshConfig())
  }

  duplicate(name: string): boolean {
    return this.add(name, structuredClone(this.get().config))
  }

  /** Save the live config under a (new or existing) name and select it. */
  saveAs(name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    const { config, saved } = this.get()
    const existing = saved.findIndex((s) => sameName(s.name, trimmed))
    if (existing < 0) return void this.add(trimmed, config)
    this.flush()
    this.set({ saved: saved.map((s, i) => (i === existing ? { ...config, name: trimmed } : s)), active: trimmed })
    this.write(this.keys.saved, this.keys.active)
  }

  renameActive(next: string): boolean {
    const trimmed = next.trim()
    const { saved, active, config } = this.get()
    if (active) return this.renameGraph(active, trimmed)
    if (this.nameError(trimmed, '')) return false
    this.flush()
    this.set({ saved: [...saved, { ...config, name: trimmed }], active: trimmed, defaultConfig: freshConfig() })
    this.write(this.keys.config, this.keys.saved, this.keys.active)
    return true
  }

  renameGraph(name: string, next: string): boolean {
    const trimmed = next.trim()
    const { saved, active } = this.get()
    if (!saved.some((s) => s.name === name) || this.nameError(trimmed, name)) return false
    if (trimmed === name) return true
    this.flush()
    this.set({ saved: saved.map((s) => (s.name === name ? { ...s, name: trimmed } : s)), active: active === name ? trimmed : active })
    this.write(this.keys.saved, this.keys.active)
    return true
  }

  deleteActive(): boolean {
    const { active } = this.get()
    return Boolean(active) && this.deleteGraph(active)
  }

  deleteGraph(name: string): boolean {
    const { saved, active, config, defaultConfig } = this.get()
    if (!saved.some((s) => s.name === name)) return false
    this.flush()
    this.set({ saved: saved.filter((s) => s.name !== name), active: active === name ? '' : active, config: active === name ? defaultConfig : config })
    this.write(this.keys.saved, this.keys.active)
    return true
  }

  /** Run a graph-list change and put it on the app's ⌘Z stack. */
  undoable(label: string, change: () => boolean): boolean {
    const before = structuredClone(this.get())
    if (!change()) return false
    const after = structuredClone(this.get())
    const to = (state: StoreState) => async () => {
      try {
        await this.restore(state)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }
    api.undo.push({ label, undo: to(before), redo: to(after) })
    return true
  }
}

/**
 * Owner-scoped store registry keyed by the config key string. It remains stable
 * across module re-imports within one plugin load and is cleared on unload.
 */
const stores = (): Map<string, PresetStore> =>
  api.runtime.getOrCreate('graphView.presetStores', () => new Map())

export function storeFor(keys: PresetKeys): PresetStore {
  const registry = stores()
  let store = registry.get(keys.config)
  if (!store) {
    store = new PresetStore(keys)
    registry.set(keys.config, store)
  }
  return store
}

/**
 * Saved-graph state for one graph panel, parameterized by its settings keys so
 * the global and local graphs keep fully independent configs + graph lists. All
 * views sharing a key-set observe the same store and re-render together.
 */
export function useGraphPresets(keys: PresetKeys): GraphPresets {
  const store = storeFor(keys)
  const [, force] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => store.subscribe(force), [store])

  const { config, saved, active } = store.get()
  return {
    config,
    saved,
    active,
    apply: (next) => store.apply(next),
    select: (name) => store.select(name),
    nameError: (name, renaming = false) => store.nameError(name, renaming ? active : ''),
    create: (name) => store.undoable(uiText('graph.undo.create', { p0: name.trim() }), () => store.create(name)),
    duplicate: (name) => store.undoable(uiText('graph.undo.create', { p0: name.trim() }), () => store.duplicate(name)),
    rename: (next) => store.undoable(uiText('graph.undo.rename', { p0: next.trim() }), () => store.renameActive(next)),
    remove: () => { store.undoable(uiText('graph.undo.delete', { p0: active }), () => store.deleteGraph(active)) }
  }
}
