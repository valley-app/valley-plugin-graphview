import type { PluginCommand, ValleyPluginApi } from '@valley/plugin-sdk'
import type { CommandSideEffect } from '@valley/plugin-sdk/commands'
import { GLOBAL_KEYS, LOCAL_KEYS, readPins, pinsKeyFor } from './settings'
import { storeFor } from './presets'
import { abandonGraphEdit, beforeEffect, commitGraphEdit, patchGraphSurface, readGraphSurface, refuse } from './surfaces'
import { uiText } from './localization'
import { getGraphIndex } from './indexOwner'

const resultText = { type: 'string', maxLength: 65536 }
const resultNumber = { type: 'number' }
const resultBoolean = { type: 'boolean' }
const resultObject = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })
const resultList = (items: Record<string, unknown>, maxItems = 1000): Record<string, unknown> => ({ type: 'array', items, maxItems })
const resultRecord = (additionalProperties: Record<string, unknown>): Record<string, unknown> => ({ type: 'object', propertyNames: { maxLength: 256 }, additionalProperties, maxProperties: 1000 })
const graphConfigResult = resultObject({
  plugins: resultRecord(resultBoolean), sourceColors: resultObject({ tags: resultText, attachments: resultText, orphans: resultText, plugins: resultRecord(resultText) }),
  filters: resultObject({ rules: resultList(resultObject({ id: resultText, query: resultText, exclude: resultBoolean })), showTags: resultBoolean, showAttachments: resultBoolean, showOrphans: resultBoolean, existingOnly: resultBoolean }),
  colorGroups: resultList(resultObject({ id: resultText, query: resultText, color: resultText })),
  display: resultObject({ showArrows: resultBoolean, nodeSize: resultNumber, linkThickness: resultNumber, textFade: resultNumber, showLegend: resultBoolean }),
  forces: resultObject({ center: resultNumber, repel: resultNumber, link: resultNumber, linkDistance: resultNumber }), localDepth: { type: 'integer', minimum: 0 }
})
const graphNamedResult = resultObject({ name: resultText })
export const graphResults: Record<string, Record<string, unknown>> = {
  open: resultObject({ opened: { const: true } }), 'open-local': resultObject({ opened: { const: true } }), search: resultObject({ query: resultText }), focus: resultObject({ path: resultText }),
  inspect: resultObject({ config: graphConfigResult, saved: resultList(resultObject({ ...(graphConfigResult.properties as Record<string, unknown>), name: resultText })), active: resultText, defaultConfig: graphConfigResult, pins: resultRecord(resultObject({ x: resultNumber, y: resultNumber })) }),
  'preset-save': graphNamedResult, 'preset-select': graphNamedResult, 'preset-rename': graphNamedResult, 'preset-delete': graphNamedResult, pin: resultObject({ id: resultText, pinned: resultBoolean }),
  'properties-edit': resultObject({ updated: resultList({ enum: ['config', 'preset', 'centerId'] }, 3) })
}

/**
 * `graphView:*` command-bus commands — open the graph from ⌘P/CLI/agent and
 * point it at a query or file. Filter changes write the persisted config, so
 * a freshly opened tab picks them up.
 */
export function registerGraphCommands(api: ValleyPluginApi): () => void {
  const register = <I = void, O = void, E extends CommandSideEffect = 'read'>(definition: PluginCommand<I, O, E>): (() => void) => {
    const outputSchema = graphResults[definition.id]
    if (!outputSchema) throw new Error(`Missing result contract for ${definition.id}.`)
    const command: PluginCommand<I, O, E> & { outputSchema: Record<string, unknown>; limits: Record<string, number> } = { ...definition, outputSchema, limits: { requestBytes: 1048576, responseBytes: 1048576 } }
    return api.commands.register(command)
  }
  const index = getGraphIndex(api)
  let active = true
  // One command-set query replaces the whole rule list, exactly as it replaced
  // the single query box it used to write.
  const setQuery = async (query: string) => {
    const store = storeFor(GLOBAL_KEYS)
    const previous = structuredClone(store.get())
    const config = previous.config
    const rules = query.trim() ? [{ id: 'f0', query, exclude: false }] : []
    await commitGraphEdit(store, previous, () => store.apply({ ...config, filters: { ...config.filters, rules } }))
    return { store, previous, revert: { label: uiText('surface.config'), run: async () => store.restore(previous) } }
  }

  const offs = [
    register({
      id: 'open',
      menu: false,
      label: 'Graph: open', labelKey: 'auto.294209f3ac65',
      paletteSafe: true,
      // Opening or focusing a tab changes window state; it is not a read.
      sideEffect: 'execute',
      input: { schema: { type: 'object', properties: { newTab: { type: 'boolean' } }, additionalProperties: false }, parse: (raw) => ({ newTab: (raw as { newTab?: unknown } | undefined)?.newTab === true }) },
      run: ({ newTab }) => {
        api.workspace.openMainTab({ newTab })
        return { opened: true }
      },
      formatCli: () => 'Opened the graph.'
    }),
    register({
      id: 'open-local', menu: { group: 'view', order: 10, label: 'Open Local Graph', labelKey: 'menu.openLocal' }, label: 'Open local graph view', labelKey: 'surface.openLocal', sideEffect: 'execute', paletteSafe: true,
      run: () => { api.workspace.revealOwnPanel('right_sidebar'); return { opened: true } }
    }),
    register({
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
        const { revert } = await setQuery(query)
        api.workspace.openMainTab()
        return { value: { query }, revert }
      },
      formatCli: (v) => `Graph filtered to "${(v as { query: string }).query}".`
    }),
    register({
      id: 'focus',
      label: 'Graph: focus a file', labelKey: 'auto.9787b2e2d912',
      paletteSafe: false,
      sideEffect: 'write',
      revision: () => storeFor(GLOBAL_KEYS).get(),
      usage: 'graphView focus <realm-relative path>',
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
        await beforeEffect(async () => {
          if (!active) throw refuse('GRAPH_UNAVAILABLE', uiText('surface.unavailable'))
          await index.ready()
        })
        const previousCenter = beforeEffect(() => {
          if (!active) throw refuse('GRAPH_UNAVAILABLE', uiText('surface.unavailable'))
          index.assertCurrent()
          if (!index.entries().some((entry) => entry.relPath === path)) throw refuse('GRAPH_NODE_UNAVAILABLE', uiText('surface.unavailable'))
          return readGraphSurface('main_workspace').centerId
        })
        const { store, previous, revert: config } = await setQuery(`path:"${path}"`)
        // The filter is already committed here, so a failure must roll it back and report an unknown outcome.
        try {
          if (!active) throw refuse('GRAPH_UNAVAILABLE', uiText('surface.unavailable'))
          index.assertCurrent()
        } catch (cause) { throw await abandonGraphEdit(store, previous, cause) }
        patchGraphSurface('main_workspace', { centerId: path })
        api.workspace.openMainTab()
        // Undo puts back both effects: the stored filter and the centre focus moved the graph to.
        const revert = { label: config.label, run: async () => { try { await config.run() } finally { patchGraphSurface('main_workspace', { centerId: previousCenter }) } } }
        return { value: { path }, revert }
      },
      formatCli: (v) => `Graph focused on ${(v as { path: string }).path}.`
    })
  ]
  const parseScope = (raw: unknown): { local: boolean } => ({ local: (raw as { local?: unknown })?.local === true })
  offs.push(register({
    id: 'inspect', label: 'Graph: Inspect configuration and saved graphs', labelKey: 'surface.inspect', sideEffect: 'read', paletteSafe: false,
    input: { schema: { type: 'object', properties: { local: { type: 'boolean' } }, additionalProperties: false }, parse: parseScope, fromCli: (_args, flags) => ({ local: flags.local === true }) },
    run: ({ local }) => ({ ...structuredClone(storeFor(local ? LOCAL_KEYS : GLOBAL_KEYS).get()), pins: readPins(local ? LOCAL_KEYS : GLOBAL_KEYS) })
  }))
  for (const operation of ['save', 'select', 'rename', 'delete'] as const) {
    offs.push(register<{ name: string; to: string; local: boolean }, { name: string }, 'write'>({
      id: `preset-${operation}`, label: `Graph: ${operation} saved graph`, labelKey: `surface.preset-${operation}`, sideEffect: 'write', paletteSafe: false,
      input: { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 }, to: { type: 'string' }, local: { type: 'boolean' } }, additionalProperties: false }, parse: (raw) => {
        const input = raw as { name?: unknown; to?: unknown; local?: unknown }
        if (typeof input?.name !== 'string' || !input.name.trim() || (operation === 'rename' && (typeof input.to !== 'string' || !input.to.trim()))) throw new Error(uiText('surface.invalid'))
        return { name: input.name.trim(), to: typeof input.to === 'string' ? input.to.trim() : '', local: input.local === true }
      }, fromCli: (args, flags) => ({ name: args.join(' '), to: flags.to, local: flags.local === true }) },
      revision: ({ local }) => storeFor(local ? LOCAL_KEYS : GLOBAL_KEYS).get(),
      run: async ({ name, to, local }) => {
        const { store, previous } = beforeEffect(() => {
          const store = storeFor(local ? LOCAL_KEYS : GLOBAL_KEYS)
          const previous = structuredClone(store.get())
          if (operation !== 'save' && !previous.saved.some((preset) => preset.name === name)) throw refuse('GRAPH_PRESET_UNAVAILABLE', uiText('surface.unavailable'))
          // The same check renameGraph makes before it changes anything.
          if (operation === 'rename' && store.nameError(to, name)) throw refuse('GRAPH_PRESET_NAME_INVALID', uiText('surface.invalid'))
          return { store, previous }
        })
        await commitGraphEdit(store, previous, () => {
          if (operation === 'save') store.saveAs(name)
          else if (operation === 'select') store.select(name)
          else if (operation === 'delete') store.deleteGraph(name)
          else if (!store.renameGraph(name, to)) throw new Error(uiText('surface.invalid'))
        })
        return { value: { name: operation === 'rename' ? to : name }, revert: { label: uiText(`surface.preset-${operation}`), run: async () => store.restore(previous) } }
      }
    }))
  }
  offs.push(register<{ id: string; x?: number; y?: number; local: boolean }, { id: string; pinned: boolean }, 'write'>({
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
