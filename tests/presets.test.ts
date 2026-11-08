import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi, type MockValleyApi } from '@valley/plugin-testkit'
import { initRuntime } from '../src/runtime'
import { PresetStore } from '../src/presets'
import { DEFAULT_CONFIG, GLOBAL_KEYS, LOCAL_KEYS } from '../src/settings'
import type { GraphConfig } from '../src/types'

const tweak = (config: GraphConfig, nodeSize: number): GraphConfig => ({
  ...config,
  display: { ...config.display, nodeSize }
})

const settingsWrites = (mock: MockValleyApi): { key: string; value: unknown }[] =>
  mock.driverCalls
    .filter((c) => c.driver === 'settings')
    .map((c) => c.payload as { key: string; value: unknown })

describe('PresetStore', () => {
  let mock: MockValleyApi
  let store: PresetStore

  beforeEach(() => {
    vi.useFakeTimers()
    mock = createMockValleyApi()
    initRuntime(mock.api)
    store = new PresetStore(GLOBAL_KEYS)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initializes from defaults when nothing is persisted', () => {
    expect(store.get().config).toEqual(DEFAULT_CONFIG)
    expect(store.get().saved).toEqual([])
    expect(store.get().active).toBe('')
  })

  it('apply updates state + notifies synchronously but debounces the disk write', () => {
    const listener = vi.fn()
    store.subscribe(listener)
    store.apply(tweak(store.get().config, 2))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get().config.display.nodeSize).toBe(2)
    expect(settingsWrites(mock)).toHaveLength(0)

    store.apply(tweak(store.get().config, 2.5))
    store.apply(tweak(store.get().config, 3))
    vi.advanceTimersByTime(500)
    const writes = settingsWrites(mock)
    expect(writes).toHaveLength(1)
    expect(writes[0].key).toBe(GLOBAL_KEYS.config)
    expect((writes[0].value as GraphConfig).display.nodeSize).toBe(3)
  })

  it('flushes a pending config write before preset writes, preserving order', () => {
    store.apply(tweak(store.get().config, 1.8))
    store.saveAs('Habitats')
    const keys = settingsWrites(mock).map((w) => w.key)
    expect(keys).toEqual([GLOBAL_KEYS.config, GLOBAL_KEYS.saved, GLOBAL_KEYS.active])
    expect(store.get().active).toBe('Habitats')
    expect(store.get().saved[0].display.nodeSize).toBe(1.8)
  })

  it('flushes the pending debounce before unload without rewriting clean settings', async () => {
    store.apply(tweak(store.get().config, 2.4))
    await mock.runBeforeUnload()
    expect(settingsWrites(mock)).toMatchObject([{ key: GLOBAL_KEYS.config, value: store.get().config }])
    await mock.runBeforeUnload()
    await vi.advanceTimersByTimeAsync(500)
    expect(settingsWrites(mock)).toHaveLength(1)
  })

  it('refuses unload after a failed save, preserves the draft and allows a later retry', async () => {
    const original = mock.api.settings.set
    const write = vi.spyOn(mock.api.settings, 'set').mockRejectedValueOnce(new Error('Synthetic save failure'))
    store.apply(tweak(store.get().config, 2.6))
    await expect(mock.runBeforeUnload()).rejects.toThrow('Synthetic save failure')
    expect(store.get().config.display.nodeSize).toBe(2.6)
    write.mockImplementation(original)
    await mock.runBeforeUnload()
    expect(settingsWrites(mock)).toMatchObject([{ key: GLOBAL_KEYS.config, value: store.get().config }])
    write.mockRestore()
  })

  it('waits for an in-flight save and flushes newer edits made while it is pending', async () => {
    let complete!: () => void
    const original = mock.api.settings.set
    const write = vi.spyOn(mock.api.settings, 'set').mockImplementationOnce((key, value) => new Promise((resolve) => {
      complete = () => { void original(key, value).then(resolve) }
    }))
    store.apply(tweak(store.get().config, 2))
    vi.advanceTimersByTime(400)
    let finished = false
    const unloading = mock.runBeforeUnload().then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    store.apply(tweak(store.get().config, 3))
    complete()
    await unloading
    expect(settingsWrites(mock).map(write => (write.value as GraphConfig).display.nodeSize)).toEqual([2, 3])
    expect(finished).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(settingsWrites(mock)).toHaveLength(2)
    write.mockRestore()
  })

  it('refuses unload when the settings service returns an unsuccessful result', async () => {
    const write = vi.spyOn(mock.api.settings, 'set').mockResolvedValueOnce({ ok: false, error: 'Synthetic refusal' })
    store.apply(tweak(store.get().config, 2.8))
    await expect(mock.runBeforeUnload()).rejects.toThrow('Graph settings could not be saved.')
    expect(store.get().config.display.nodeSize).toBe(2.8)
    write.mockRestore()
  })

  it('saves edits into the active graph and switches without losing either graph', () => {
    store.apply(tweak(store.get().config, 2.2))
    expect(store.create('Big')).toBe(true)
    expect(store.get().config).toEqual(DEFAULT_CONFIG)
    store.apply(tweak(store.get().config, 0.8))
    mock.driverCalls.length = 0
    store.select('')
    expect(store.get().config.display.nodeSize).toBe(2.2)
    expect(store.get().active).toBe('')
    expect(settingsWrites(mock).map((write) => write.key)).toEqual([GLOBAL_KEYS.saved, GLOBAL_KEYS.active])
    store.select('Big')
    expect(store.get().config.display.nodeSize).toBe(0.8)
    expect(new PresetStore(GLOBAL_KEYS).get().saved.find((graph) => graph.name === 'Big')?.display.nodeSize).toBe(0.8)
    expect(new PresetStore(GLOBAL_KEYS).get().defaultConfig.display.nodeSize).toBe(2.2)
  })

  it('round-trips plugin switches in independently saved global and local graphs', () => {
    const local = new PresetStore(LOCAL_KEYS)
    store.apply({ ...store.get().config, plugins: { fieldwork: false } })
    local.apply({ ...local.get().config, plugins: { fieldwork: true, observations: false } })
    store.saveAs('Global')
    local.saveAs('Local')
    store.select('')
    local.select('')
    store.apply({ ...store.get().config, plugins: {} })
    local.apply({ ...local.get().config, plugins: {} })
    store.select('Global')
    local.select('Local')
    expect(store.get().config.plugins).toEqual({ fieldwork: false })
    expect(local.get().config.plugins).toEqual({ fieldwork: true, observations: false })
    expect(new PresetStore(GLOBAL_KEYS).get().saved[0].plugins).toEqual({ fieldwork: false })
    expect(new PresetStore(LOCAL_KEYS).get().saved[0].plugins).toEqual({ fieldwork: true, observations: false })
  })

  it('names the Default graph by saving it and resetting Default to the whole realm', () => {
    store.apply({ ...tweak(store.get().config, 2), filters: { ...store.get().config.filters, rules: [{ id: 'x', query: 'tag:#draft', exclude: true }] } })
    expect(store.renameActive('Research')).toBe(true)
    expect(store.get().active).toBe('Research')
    expect(store.get().config.display.nodeSize).toBe(2)
    expect(store.get().defaultConfig).toEqual(DEFAULT_CONFIG)
    store.select('')
    expect(store.get().config).toEqual(DEFAULT_CONFIG)
  })

  it('creates whole-realm graphs, duplicates the current one and keeps names unique ignoring case', () => {
    store.apply(tweak(store.get().config, 1.6))
    expect(store.duplicate('Research')).toBe(true)
    expect(store.get().config.display.nodeSize).toBe(1.6)
    expect(store.create(' research ')).toBe(false)
    expect(store.nameError('RESEARCH', '')).toBe('A graph with this name already exists.')
    expect(store.nameError('   ', '')).toBe('Enter a name for the graph.')
    expect(store.create('Fresh')).toBe(true)
    expect(store.get().config).toEqual(DEFAULT_CONFIG)
    expect(store.get().saved.map((graph) => graph.name)).toEqual(['Research', 'Fresh'])
  })

  it('treats a missing active graph as the Default graph', async () => {
    await mock.api.settings.set(GLOBAL_KEYS.active, 'Overview')
    await mock.api.settings.set(GLOBAL_KEYS.config, tweak(DEFAULT_CONFIG, 1.4))
    const reopened = new PresetStore(GLOBAL_KEYS)
    expect(reopened.get().active).toBe('')
    expect(reopened.get().config.display.nodeSize).toBe(1.4)
  })

  it('renames and deletes any saved graph, refusing duplicates and falling back to Default', () => {
    store.saveAs('A')
    store.saveAs('B')
    expect(store.renameActive('a')).toBe(false)
    expect(store.get().active).toBe('B')
    expect(store.renameActive('C')).toBe(true)
    expect(store.renameGraph('A', 'D')).toBe(true)
    expect(store.get().saved.map((s) => s.name)).toEqual(['D', 'C'])
    expect(store.get().active).toBe('C')
    store.apply(tweak(store.get().config, 2.9))
    expect(store.deleteActive()).toBe(true)
    expect(store.get().saved.map((s) => s.name)).toEqual(['D'])
    expect(store.get().active).toBe('')
    expect(store.get().config).toEqual(store.get().defaultConfig)
  })

  it('puts graph-list changes on the undo stack', async () => {
    store.saveAs('Keep')
    expect(store.undoable('Delete graph “Keep”', () => store.deleteActive())).toBe(true)
    expect(store.undoable('noop', () => store.deleteActive())).toBe(false)
    expect(mock.undoActions).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(await mock.undoActions[0].undo()).toEqual({ ok: true })
    expect(store.get().saved.map((s) => s.name)).toEqual(['Keep'])
    expect(store.get().active).toBe('Keep')
    expect(await mock.undoActions[0].redo?.()).toEqual({ ok: true })
    expect(store.get().saved).toEqual([])
  })
})
