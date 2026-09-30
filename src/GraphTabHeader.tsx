import { React } from './runtime'
import { Search, X } from './icons'
import { uiText } from './localization'

export interface GraphFind {
  value: string
  /** Matching nodes. */
  count: number
  /** Position of the focused match, or -1 before the first Enter. */
  index: number
  onChange: (value: string) => void
  onStep: (delta: 1 | -1) => void
}

export const GraphTabHeader = ({ name }: { name?: string }): ReturnType<typeof React.createElement> => (
  <div className="graphview-topbar">
    <span className="graphview-topbar-title graphview-title-text">{name || uiText('graph.default')}</span>
  </div>
)

export const GraphSearchInput = ({ find }: { find: GraphFind }): ReturnType<typeof React.createElement> => {
  const label = uiText('graph.find')
  const hasQuery = Boolean(find.value.trim())
  return (
    <div className="search-field-row graphview-searchbar">
      <div className="graphview-find">
        <div className="search-field">
          <Search className="search-field-icon" />
          <input
            type="search"
            className="search-field-input"
            spellCheck={false}
            placeholder={label}
            aria-label={label}
            value={find.value}
            onChange={(e) => find.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                find.onStep(e.shiftKey ? -1 : 1)
              }
              if (e.key === 'Escape') {
                find.onChange('')
                e.currentTarget.blur()
              }
            }}
          />
          {hasQuery ? (
            <span className="graphview-find-count" title={find.count ? undefined : uiText('graph.find.none')}>
              {find.index >= 0 && find.count ? `${find.index + 1}/${find.count}` : find.count}
            </span>
          ) : null}
          {hasQuery ? (
            <button type="button" className="search-field-action" aria-label={uiText('graph.find.clear')} title={uiText('graph.find.clear')} onClick={() => find.onChange('')}>
              <X />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
