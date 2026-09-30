import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { GLOBAL_KEYS, LOCAL_KEYS, readPins, pinsKeyFor } from './settings'
import { storeFor } from './presets'
import { patchGraphSurface } from './surfaces'
import { uiText } from './localization'
import { getGraphIndex } from './indexOwner'

/**
 * `graphView:*` command-bus commands — open the graph from ⌘P/CLI/agent and
 * point it at a query or file. Filter changes write the persisted config, so
 * a freshly opened tab picks them up.
 */
export function registerGraphCommands(api: ValleyPluginApi): () => void {
  const index = getGraphIndex(api)
  let active = true
  // One command-set query replaces the whole rule list, exactly as it replaced
  // the single query box it used to write.
  const setQuery = async (query: string) => {
    const store = storeFor(GLOBAL_KEYS)
    const previous = structuredClone(store.get())
    const config = previous.config
    const rules = query.trim() ? [{ id: 'f0', query, exclude: false }] : []
    store.apply({ ...config, filters: { ...config.filters, rules } })
    await store.commit()
    return { label: uiText('surface.config'), run: async () => store.restore(previous) }
  }

  const offs = [
    api.commands.register({
      id: 'open',
      label: 'Graph: open', labelKey: 'auto.294209f3ac65',
      paletteSafe: true,
      sideEffect: 'read',
      input: { schema: { type: 'object', properties: { newTab: { type: 'boolean' } }, additionalProperties: false }, parse: (raw) => ({ newTab: (raw as { newTab?: unknown } | undefined)?.newTab === true }) },
      run: ({ newTab }) => {
        api.workspace.openMainTab({ newTab })
        return { opened: true }
      },
      formatCli: () => 'Opened the graph.'
    }),
    api.commands.register({
      id: 'open-local', label: 'Open local graph view', labelKey: 'surface.openLocal', sideEffect: 'read', paletteSafe: true,
      run: () => { api.workspace.revealOwnPanel('right_sidebar'); return { opened: true } }
    }),
    api.commands.register({
      id: 'search',
      label: 'Graph: filter by query', labelKey: 'auto.aa75a777b344',
      paletteSafe: false,
      sideEffect: 'write',
      revision: () => storeFor(GLOBAL_KEYS).get(),
      usage: 'graphView search <query>  (supports tag:/path: operators, - negates)',
      input: {
        schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
        parse: (raw) => {
          const query = typeof (raw as Record<string, unknown>)?.query === 'string'
            ? ((raw as Record<string, unknown>).query as string)
            : ''
          return { query }
        },
        fromCli: (args) => ({ query: args.join(' ').trim() })
      },
      run: async ({ query }) => {
        const revert = await setQuery(query)
        api.workspace.openMainTab()
        return { value: { query }, revert }
      },
      formatCli: (v) => `Graph filtered to "${(v as { query: string }).query}".`
    }),
    api.commands.register({
      id: 'focus',
      label: 'Graph: focus a file', labelKey: 'auto.9787b2e2d912',
      paletteSafe: false,
      sideEffect: 'write',
      revision: () => storeFor(GLOBAL_KEYS).get(),
      usage: 'graphView focus <vault-relative path>',
      input: {
        schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        parse: (raw) => {
          const path = typeof (raw as Record<string, unknown>)?.path === 'string'
            ? ((raw as Record<string, unknown>).path as string).trim()
            : ''
          if (!path) throw new Error('Usage: graphView focus <path>')
          return { path }
        },
        fromCli: (args) => ({ path: args.join(' ').trim() })
      },
      run: async ({ path }) => {
        if (!active) throw new Error(uiText('surface.unavailable'))
        await index.ready()
        if (!active) throw new Error(uiText('surface.unavailable'))
        index.assertCurrent()
        if (!index.entries().some((entry) => entry.relPath === path)) throw new Error(uiText('surface.unavailable'))
        const revert = await setQuery(`path:"${path}"`)
        if (!active) throw new Error(uiText('surface.unavailable'))
        index.assertCurrent()
        patchGraphSurface('main_workspace', { centerId: path })
        api.workspace.openMainTab()
        return { value: { path }, revert }
      },
      formatCli: (v) => `Graph focused on ${(v as { path: string }).path}.`
    })
  ]
  const parseScope = (raw: unknown): { local: boolean } => ({ local: (raw as { local?: unknown })?.local === true })
  offs.push(api.commands.register({
    id: 'inspect', label: 'Graph: Inspect configuration and saved graphs', labelKey: 'surface.inspect', sideEffect: 'read', paletteSafe: false,
    input: { schema: { type: 'object', properties: { local: { type: 'boolean' } }, additionalProperties: false }, parse: parseScope, fromCli: (_args, flags) => ({ local: flags.local === true }) },
    run: ({ local }) => ({ ...structuredClone(storeFor(local ? LOCAL_KEYS : GLOBAL_KEYS).get()), pins: readPins(local ? LOCAL_KEYS : GLOBAL_KEYS) })
  }))
  for (const operation of ['save', 'select', 'rename', 'delete'] as const) {
    offs.push(api.commands.register<{ name: string; to: string; local: boolean }, { name: string }, 'write'>({
      id: `preset-${operation}`, label: `Graph: ${operation} saved graph`, labelKey: `surface.preset-${operation}`, sideEffect: 'write', paletteSafe: false,
      input: { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 }, to: { type: 'string' }, local: { type: 'boolean' } }, additionalProperties: false }, parse: (raw) => {
        const input = raw as { name?: unknown; to?: unknown; local?: unknown }
        if (typeof input?.name !== 'string' || !input.name.trim() || (operation === 'rename' && (typeof input.to !== 'string' || !input.to.trim()))) throw new Error(uiText('surface.invalid'))
        return { name: input.name.trim(), to: typeof input.to === 'string' ? input.to.trim() : '', local: input.local === true }
      }, fromCli: (args, flags) => ({ name: args.join(' '), to: flags.to, local: flags.local === true }) },
      revision: ({ local }) => storeFor(local ? LOCAL_KEYS : GLOBAL_KEYS).get(),
      run: async ({ name, to, local }) => {
        const store = storeFor(local ? LOCAL_KEYS : GLOBAL_KEYS)
        const previous = structuredClone(store.get())
        if (operation !== 'save' && !previous.saved.some((preset) => preset.name === name)) throw new Error(uiText('surface.unavailable'))
        if (operation === 'save') store.saveAs(name)
        else if (operation === 'select') store.select(name)
        else if (operation === 'delete') store.deleteGraph(name)
        else if (!store.renameGraph(name, to)) throw new Error(uiText('surface.invalid'))
        await store.commit()
        return { value: { name: operation === 'rename' ? to : name }, revert: { label: uiText(`surface.preset-${operation}`), run: async () => store.restore(previous) } }
      }
    }))
  }
  offs.push(api.commands.register<{ id: string; x?: number; y?: number; local: boolean }, { id: string; pinned: boolean }, 'write'>({
    id: 'pin', label: 'Graph: Pin or unpin a node', labelKey: 'surface.pin', sideEffect: 'write', paletteSafe: false,
    input: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 }, x: { type: 'number' }, y: { type: 'number' }, local: { type: 'boolean' } }, additionalProperties: false }, parse: (raw) => {
      const input = raw as { id?: unknown; x?: unknown; y?: unknown; local?: unknown }
      if (typeof input?.id !== 'string' || !input.id || ((input.x !== undefined || input.y !== undefined) && (typeof input.x !== 'number' || !Number.isFinite(input.x) || typeof input.y !== 'number' || !Number.isFinite(input.y)))) throw new Error(uiText('surface.invalid'))
      return { id: input.id, x: input.x as number | undefined, y: input.y as number | undefined, local: input.local === true }
    }, fromCli: (args, flags) => ({ id: args.join(' '), ...(flags.x !== undefined ? { x: Number(flags.x), y: Number(flags.y) } : {}), local: flags.local === true }) },
    revision: ({ local }) => readPins(local ? LOCAL_KEYS : GLOBAL_KEYS),
    run: async ({ id, x, y, local }) => {
      const keys = local ? LOCAL_KEYS : GLOBAL_KEYS
      const previous = readPins(keys)
      const next = { ...previous }
      if (x !== undefined && y !== undefined) next[id] = { x, y }
      else delete next[id]
      const result = await api.settings.set(pinsKeyFor(keys), next)
      if (!result.ok) throw new Error(uiText('surface.invalid'))
      return { value: { id, pinned: x !== undefined }, revert: { label: uiText('surface.pin'), run: async () => { const result = await api.settings.set(pinsKeyFor(keys), previous); if (!result.ok) throw new Error(uiText('surface.invalid')) } } }
    }
  }))
  return () => {
    active = false
    for (const off of offs) off()
  }
}
