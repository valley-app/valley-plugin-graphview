import { useGraphPresets } from './presets'
import { GLOBAL_KEYS } from './settings'
import { React, api } from './runtime'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type { ColorGroup, FilterRule, FilterState, GraphConfig, GraphSourcePlugin, SourceColorState } from './types'
import { graphPluginColors, graphPluginSources } from './graphModel'
import { QUERY_PLACEHOLDER, filterCounts } from './filters'
import { uiText } from './localization'
import { Eye, Filter, GripVertical, Groups, Minus, Vault, X } from './icons'
import { useIndexEntries, useNoteDocuments } from './useGraph'
import { nextPaletteColor, runtimePaletteSnapshot, subscribeRuntimePalette } from '@valley/plugin-sdk/palette'

export type GraphSection = 'filters' | 'groups' | 'display'

export const GRAPH_SECTIONS: readonly GraphSection[] = ['filters', 'groups', 'display']

const SECTIONS: { id: GraphSection; icon: (p: { className?: string }) => ReactElement }[] = [
  { id: 'filters', icon: Filter },
  { id: 'groups', icon: Groups },
  { id: 'display', icon: Eye }
]

const sectionLabel = (id: GraphSection): string =>
  id === 'groups' ? uiText('graph.groups')
    : id === 'filters' ? uiText('auto.96e578211aa2')
      : uiText('auto.574ff9b0c49c')

const formatCount = (value: number): string => new Intl.NumberFormat(api.ui.language()).format(value)

const Switch = ({
  label,
  checked,
  onChange,
  trailing
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  trailing?: ReactNode
}): ReactElement => {
  const { Toggle } = api.ui.settings
  return (
    <div className="graphview-row">
      <span className="graphview-row-label">{label}</span>
      {trailing}
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  )
}

const Slider = ({
  label,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}): ReactElement => {
  const fill = ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100
  return (
    <div className="graphview-slider-row">
      <div className="graphview-slider-head">
        <span>{label}</span>
        <span className="graphview-value">{step >= 1 ? value : value.toFixed(1)}</span>
      </div>
      <input
        type="range"
        className="graphview-slider"
        style={{ '--slider-fill': `${fill}%` } as CSSProperties}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  )
}

const newRuleId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * The graph starts from its base — the whole vault unless the base query names
 * fewer files — and every exclusion subtracts from that base. Counts say how
 * many files each step covers, so it is always clear what is being removed.
 */
const QueryRules = ({
  rules,
  showAttachments,
  onChange
}: {
  rules: FilterRule[]
  showAttachments: boolean
  onChange: (rules: FilterRule[]) => void
}): ReactElement => {
  const entries = useIndexEntries()
  const counts = React.useMemo(() => filterCounts(entries, rules, showAttachments), [entries, rules, showAttachments])
  const [baseFocused, setBaseFocused] = React.useState(false)
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const includes = rules.filter((rule) => !rule.exclude)
  const excludes = rules.filter((rule) => rule.exclude)
  const hasBase = includes.some((rule) => rule.query.trim())

  const patch = (id: string, query: string): void => onChange(rules.map((rule) => (rule.id === id ? { ...rule, query } : rule)))
  const remove = (id: string): void => onChange(rules.filter((rule) => rule.id !== id))
  // The first base field edits the first include rule — or creates it — under
  // one stable key, so typing into "Whole vault" keeps the caret in place.
  const setBase = (query: string): void => {
    const first = includes[0]
    if (!first) {
      if (query) onChange([{ id: newRuleId('b'), query, exclude: false }, ...rules])
    } else if (!query && includes.length === 1) remove(first.id)
    else patch(first.id, query)
  }
  const addExclusion = (): void => {
    const id = newRuleId('x')
    setFocusId(id)
    onChange([...rules, { id, query: '', exclude: true }])
  }

  const baseCount = (
    <span className="graphview-count" title={uiText('graph.count.files', { p0: formatCount(counts.base) })}>
      {formatCount(counts.base)}
    </span>
  )
  const wholeVault = uiText('graph.wholeVault')
  const first = includes[0]

  return (
    <>
      <div className="graphview-group" key="base">
        <div className="graphview-query">
          <div className="search-field graphview-base" data-empty={!first?.query && !baseFocused ? 'true' : undefined} title={uiText('graph.base.hint')}>
            <Vault className="search-field-icon" />
            <input
              className="search-field-input"
              spellCheck={false}
              aria-label={uiText('graph.base.label')}
              placeholder={baseFocused ? QUERY_PLACEHOLDER : wholeVault}
              value={first?.query ?? ''}
              onFocus={() => setBaseFocused(true)}
              onBlur={() => setBaseFocused(false)}
              onChange={(e) => setBase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setBase('')
              }}
            />
            {includes.length <= 1 ? baseCount : null}
            {first?.query ? (
              <button type="button" className="search-field-action" aria-label={uiText('graph.base.clear')} title={uiText('graph.base.clear')} onClick={() => setBase('')}>
                <X />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {includes.slice(1).map((rule) => (
        <div className="graphview-group" key={rule.id}>
          <div className="graphview-query">
            <div className="search-field graphview-base">
              <Vault className="search-field-icon" />
              <input
                className="search-field-input"
                spellCheck={false}
                aria-label={uiText('graph.base.label')}
                placeholder={QUERY_PLACEHOLDER}
                value={rule.query}
                onChange={(e) => patch(rule.id, e.target.value)}
              />
              {rule === includes[includes.length - 1] && hasBase ? baseCount : null}
              <button type="button" className="search-field-action" aria-label={uiText('auto.e963907dac5c')} title={uiText('auto.e963907dac5c')} onClick={() => remove(rule.id)}>
                <X />
              </button>
            </div>
          </div>
        </div>
      ))}
      {excludes.map((rule) => {
        const removed = counts.excluded[rule.id]
        return (
          <div className="graphview-group" key={rule.id}>
            <div className="graphview-query">
              <div className="search-field graphview-exclusion">
                <Minus className="search-field-icon" />
                <input
                  className="search-field-input"
                  spellCheck={false}
                  autoFocus={rule.id === focusId}
                  aria-label={uiText('graph.exclusion.label')}
                  placeholder={QUERY_PLACEHOLDER}
                  value={rule.query}
                  onChange={(e) => patch(rule.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') patch(rule.id, '')
                  }}
                />
                {removed !== undefined ? (
                  <span className="graphview-count" title={uiText('graph.count.removed', { p0: formatCount(removed) })}>
                    −{formatCount(removed)}
                  </span>
                ) : null}
                <button type="button" className="search-field-action" aria-label={uiText('graph.exclusion.remove')} title={uiText('graph.exclusion.remove')} onClick={() => remove(rule.id)}>
                  <X />
                </button>
              </div>
            </div>
          </div>
        )
      })}
      <button type="button" className="graphview-btn-accent" onClick={addExclusion}>
        {uiText('graph.exclusion.add')}
      </button>
    </>
  )
}

interface Props {
  config: GraphConfig
  onChange: (next: GraphConfig) => void
  /** Active section; `null` collapses the body to a bare chip row. Clicking the
   *  active chip emits `null` — a caller that must always show a section (the
   *  left sidebar, which holds nothing else) just ignores it. */
  section: GraphSection | null
  onSection: (next: GraphSection | null) => void
  /** Render the local-graph depth control (local panel only). */
  showDepth?: boolean
  hideTabs?: boolean
  hideArrows?: boolean
  /** Hide the base and exclusions (the local graph ignores them). */
  hideRules?: boolean
  /** Offer the legend switch (the workspace graph draws the legend). */
  legend?: boolean
}

/**
 * The Filters / Color groups / Display controls, shown one section at a time
 * behind an icon-chip strip. One component for every surface, so they can never
 * drift. Pure controlled component: every change goes back out through
 * `onChange` with a full config.
 */
export const GraphControls = ({
  config,
  onChange,
  section,
  onSection,
  showDepth,
  hideTabs,
  hideArrows,
  hideRules,
  legend
}: Props): ReactElement => {
  const { sources, error } = useNoteDocuments()
  React.useSyncExternalStore(subscribeRuntimePalette, runtimePaletteSnapshot, runtimePaletteSnapshot)
  const owners = graphPluginSources(sources)
  const colors = graphPluginColors(sources, config.sourceColors.plugins)
  const { ColorField, useReorderDrag } = api.ui.settings
  const patchFilters = (p: Partial<FilterState>): void =>
    onChange({ ...config, filters: { ...config.filters, ...p } })
  const patchSourceColors = (patch: Partial<SourceColorState>): void =>
    onChange({ ...config, sourceColors: { ...config.sourceColors, ...patch } })
  const colorField = (label: string, value: string, onColorChange: (color: string) => void): ReactElement => (
    <ColorField value={value} onChange={onColorChange} ariaLabel={uiText('graph.groups.color', { p0: label })} />
  )

  const setColorGroups = (colorGroups: ColorGroup[]): void => onChange({ ...config, colorGroups })
  const addColorGroup = (): void => {
    const base = `g${Date.now().toString(36)}`
    let id = base
    let suffix = 2
    while (config.colorGroups.some((group) => group.id === id)) id = `${base}-${suffix++}`
    setColorGroups([...config.colorGroups, {
      id,
      query: '',
      color: nextPaletteColor(config.colorGroups.map((group) => group.color))
    }])
  }
  const patchColorGroup = (id: string, patch: Partial<ColorGroup>): void =>
    setColorGroups(config.colorGroups.map((group) => group.id === id ? { ...group, ...patch } : group))
  const removeColorGroup = (id: string): void =>
    setColorGroups(config.colorGroups.filter((group) => group.id !== id))
  const groupReorder = useReorderDrag({
    items: config.colorGroups,
    getId: (group) => group.id,
    getLabel: (group) => group.query.trim() || uiText('graph.groups.untitled', { p0: config.colorGroups.indexOf(group) + 1 }),
    onReorder: setColorGroups,
    indicatorOnly: true
  })

  const open = section !== null

  const filters = (
    <>
      {hideRules ? null : (
        <QueryRules rules={config.filters.rules} showAttachments={config.filters.showAttachments} onChange={(rules) => patchFilters({ rules })} />
      )}
      <Switch
        label={uiText('auto.2ad69e7df2c9')}
        checked={config.filters.existingOnly}
        onChange={(v) => patchFilters({ existingOnly: v })}
      />
      <Switch
        label={uiText('auto.cb5dc4a4087a')}
        checked={config.filters.showOrphans}
        onChange={(v) => patchFilters({ showOrphans: v })}
        trailing={colorField(uiText('auto.cb5dc4a4087a'), config.sourceColors.orphans, (orphans) => patchSourceColors({ orphans }))}
      />
      <Switch
        label={uiText('auto.6771ade6e896')}
        checked={config.filters.showAttachments}
        onChange={(v) => patchFilters({ showAttachments: v })}
        trailing={colorField(uiText('auto.6771ade6e896'), config.sourceColors.attachments, (attachments) => patchSourceColors({ attachments }))}
      />
      <Switch
        label={uiText('auto.848eed0fbd54')}
        checked={config.filters.showTags}
        onChange={(v) => patchFilters({ showTags: v })}
        trailing={colorField(uiText('auto.848eed0fbd54'), config.sourceColors.tags, (tags) => patchSourceColors({ tags }))}
      />
      <div className="graphview-subsection-label">{uiText('graph.plugins.heading')}</div>
      {owners.map((source) => (
        <Switch
          key={source.pluginId}
          label={source.label}
          checked={config.plugins[source.pluginId] !== false}
          onChange={(enabled) => onChange({ ...config, plugins: { ...config.plugins, [source.pluginId]: enabled } })}
          trailing={colorField(source.label, colors[source.pluginId],
            (color) => patchSourceColors({ plugins: { ...config.sourceColors.plugins, [source.pluginId]: color } }))}
        />
      ))}
      {!owners.length && !error ? <p className="graphview-hint">{uiText('graph.plugins.empty')}</p> : null}
      {error ? <p role="alert" className="graphview-hint">{uiText('graph.plugins.failed')} {error}</p> : null}
      {showDepth ? (
        <Slider
          label={uiText('auto.df0e298e3562')}
          value={config.localDepth}
          min={1}
          max={10}
          step={1}
          onChange={(v) => onChange({ ...config, localDepth: Math.round(v) })}
        />
      ) : null}
    </>
  )

  const display = (
    <>
      {hideArrows ? null : <Switch
        label={uiText('auto.0cf604cb001b')}
        checked={config.display.showArrows}
        onChange={(v) => onChange({ ...config, display: { ...config.display, showArrows: v } })}
      />}
      {legend ? (
        <Switch
          label={uiText('graph.legend')}
          checked={config.display.showLegend}
          onChange={(v) => onChange({ ...config, display: { ...config.display, showLegend: v } })}
        />
      ) : null}
      <Slider
        label={uiText('auto.ffc602e0a3d3')}
        value={config.display.textFade}
        min={0.1}
        max={2}
        step={0.1}
        onChange={(v) => onChange({ ...config, display: { ...config.display, textFade: v } })}
      />
      <Slider
        label={uiText('auto.1e61b70dda4a')}
        value={config.display.nodeSize}
        min={0.4}
        max={3}
        step={0.1}
        onChange={(v) => onChange({ ...config, display: { ...config.display, nodeSize: v } })}
      />
      <Slider
        label={uiText('auto.96d3591f60ea')}
        value={config.display.linkThickness}
        min={0.4}
        max={3}
        step={0.1}
        onChange={(v) => onChange({ ...config, display: { ...config.display, linkThickness: v } })}
      />
      {/* Forces are an appearance control too — one section, not a fourth chip. */}
      <div className="graphview-subsection-label">{uiText('auto.5eb175b94606')}</div>
      <Slider
        label={uiText('auto.a2391118c814')}
        value={config.forces.center}
        min={0}
        max={3}
        step={0.1}
        onChange={(v) => onChange({ ...config, forces: { ...config.forces, center: v } })}
      />
      <Slider
        label={uiText('auto.c3d48707d414')}
        value={config.forces.repel}
        min={0.1}
        max={3}
        step={0.1}
        onChange={(v) => onChange({ ...config, forces: { ...config.forces, repel: v } })}
      />
      <Slider
        label={uiText('auto.d0517071aa37')}
        value={config.forces.link}
        min={0.1}
        max={3}
        step={0.1}
        onChange={(v) => onChange({ ...config, forces: { ...config.forces, link: v } })}
      />
      <Slider
        label={uiText('auto.5b3968877184')}
        value={config.forces.linkDistance}
        min={20}
        max={200}
        step={5}
        onChange={(v) => onChange({ ...config, forces: { ...config.forces, linkDistance: v } })}
      />
    </>
  )

  const groups = (
    <>
      <div className="graphview-hint">{uiText('graph.groups.description')}</div>
      {config.colorGroups.map((group, index) => {
        const handleProps = groupReorder.getHandleProps(group)
        const name = group.query.trim() || uiText('graph.groups.untitled', { p0: index + 1 })
        return (
          <div className="graphview-group graphview-color-group" key={group.id} {...groupReorder.getItemProps(group)}>
            <button
              {...handleProps}
              className={`${handleProps.className ?? ''} graphview-group-handle`}
              title={uiText('graph.groups.reorder')}
              aria-label={handleProps['aria-label'] ?? uiText('graph.groups.reorderLabel', { p0: name })}
            >
              <GripVertical />
            </button>
            <div className="graphview-query">
              <div className="search-field">
                <input
                  type="text"
                  className="search-field-input"
                  placeholder={QUERY_PLACEHOLDER}
                  aria-label={uiText('graph.groups.query', { p0: index + 1 })}
                  spellCheck={false}
                  value={group.query}
                  onChange={(event) => patchColorGroup(group.id, { query: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') patchColorGroup(group.id, { query: '' })
                  }}
                />
                <button
                  type="button"
                  className="search-field-action"
                  title={uiText('graph.groups.remove', { p0: name })}
                  aria-label={uiText('graph.groups.remove', { p0: name })}
                  onClick={() => removeColorGroup(group.id)}
                >
                  <X />
                </button>
              </div>
            </div>
            <ColorField
              value={group.color}
              onChange={(color) => patchColorGroup(group.id, { color })}
              ariaLabel={uiText('graph.groups.color', { p0: name })}
            />
          </div>
        )
      })}
      {groupReorder.liveRegion}
      <button type="button" className="graphview-btn-accent" onClick={addColorGroup}>
        {uiText('graph.groups.add')}
      </button>
    </>
  )

  return (
    <div className="graphview-controls" data-open={open}>
      {hideTabs ? null : <div className="graphview-chipbar" data-open={open}>
        {SECTIONS.map(({ id, icon: Icon }) => {
          const label = sectionLabel(id)
          return (
            <button
              key={id}
              type="button"
              className={`graphview-chip${section === id ? ' active' : ''}`}
              aria-pressed={section === id}
              aria-label={label}
              title={label}
              onClick={() => onSection(section === id ? null : id)}
            >
              <Icon />
            </button>
          )
        })}
      </div>}
      {open ? (
        <div className="graphview-body">
          <div className="graphview-section-label">{sectionLabel(section)}</div>
          {section === 'filters' ? filters : null}
          {section === 'groups' ? groups : null}
          {section === 'display' ? display : null}
        </div>
      ) : null}
    </div>
  )
}

export function GraphSourceSettings(): ReactElement {
  const { sources, error } = useNoteDocuments()
  const { Section, PluginCard } = api.ui.settings
  const { config, apply } = useGraphPresets(GLOBAL_KEYS)
  const [plugins, setPlugins] = React.useState<GraphSourcePlugin[]>([])
  const [metadataError, setMetadataError] = React.useState<string | null>(null)
  React.useEffect(() => {
    let active = true
    void api.backend.call<GraphSourcePlugin[]>('sourcePlugins').then(result => {
      if (active) { setPlugins(result); setMetadataError(null) }
    }).catch(reason => {
      if (active) setMetadataError(String(reason))
    })
    return () => { active = false }
  }, [sources])
  const failure = error || metadataError
  return <Section>
    <div className="graphview-source-intro"><p>{uiText('graph.plugins.description')}</p></div>
    <div className="graphview-source-list">
      {graphPluginSources(sources).map(source => {
        const plugin = plugins.find(entry => entry.id === source.pluginId)
        const name = plugin?.name ?? source.label
        return <PluginCard key={source.pluginId} name={name}
          version={plugin?.version ?? '—'} versionLabel={uiText('graph.plugins.version')}
          author={plugin?.author.join(', ')} authorLabel={uiText('graph.plugins.author')}
          description={[
            uiText('graph.plugins.nodes', { p0: plugin?.nodeTypes.join(', ') || source.label }),
            uiText(plugin?.linksSourceFiles ? 'graph.plugins.linksWithFiles' : 'graph.plugins.links')
          ].join(' ')}
          enabled={config.plugins[source.pluginId] !== false} toggleLabel={name}
          onChange={enabled => apply({ ...config, plugins: { ...config.plugins, [source.pluginId]: enabled } })}
          onConfigure={() => api.workspace.openSettings(`plugin:${source.pluginId}`)}
          configureLabel={uiText('graph.plugins.configure', { p0: name })} />
      })}
    </div>
    {!sources.length && !failure ? <p className="settings-toggle-desc">{uiText('graph.plugins.empty')}</p> : null}
    {failure ? <p role="alert" className="settings-toggle-desc">{uiText('graph.plugins.failed')} {failure}</p> : null}
  </Section>
}
