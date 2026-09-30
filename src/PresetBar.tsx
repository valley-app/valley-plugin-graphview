import { React, api } from './runtime'
import type { ReactNode } from 'react'
import type { UiMenuItem } from '@valley/plugin-sdk'
import type { GraphPresets } from './presets'
import { ChevronDown, CopyPlus, GraphIcon, Pencil, Plus, Trash, X } from './icons'
import { uiText } from './localization'

type Mode = 'idle' | 'new' | 'rename' | 'duplicate'

/**
 * The row under a graph panel's header that names the active graph. The name
 * opens the saved-graph menu — switch, rename, duplicate, delete — and + starts
 * a new whole-vault graph. Naming swaps the button for an input in the same
 * frame, so nothing shifts. Graphs save themselves; there is no Save step.
 *
 * Switching graphs re-draws the same view; it opens nothing, so it is not a
 * stop on the workspace back/forward trail.
 */
export const GraphNameBar = ({ presets, selectionOnly = false, actions }: { presets: GraphPresets; selectionOnly?: boolean; actions?: ReactNode }): ReturnType<typeof React.createElement> => {
  const [mode, setMode] = React.useState<Mode>('idle')
  const [draft, setDraft] = React.useState('')
  const [error, setError] = React.useState('')
  const nameRef = React.useRef<HTMLButtonElement | null>(null)
  const closedRef = React.useRef(true)
  const name = presets.active || uiText('graph.default')

  const start = (next: Mode): void => {
    closedRef.current = false
    setDraft(next === 'rename' ? presets.active : '')
    setError('')
    setMode(next)
  }
  const cancel = (): void => {
    closedRef.current = true
    setMode('idle')
    setDraft('')
    setError('')
  }
  const commit = (): boolean => {
    const value = draft.trim()
    const problem = presets.nameError(value, mode === 'rename')
    if (problem) {
      setError(problem)
      return false
    }
    const done = mode === 'new' ? presets.create(value) : mode === 'duplicate' ? presets.duplicate(value) : presets.rename(value)
    if (done) cancel()
    return done
  }

  const openMenu = async (): Promise<void> => {
    const anchor = nameRef.current
    if (!anchor) return
    // Radio ids carry a prefix: the host menu only selects truthy ids, and the
    // Default graph's name is ''.
    const items: UiMenuItem[] = [
      { id: 'graph:', type: 'radio', label: uiText('graph.default'), checked: !presets.active },
      ...presets.saved.map((graph) => ({ id: `graph:${graph.name}`, type: 'radio' as const, label: graph.name, checked: graph.name === presets.active })),
      ...(selectionOnly ? [] : [
      { type: 'separator' as const },
      { id: 'rename', label: uiText('auto.94ac9a58b609'), icon: <Pencil /> },
      { id: 'duplicate', label: uiText('graph.duplicate'), icon: <CopyPlus /> },
      { id: 'delete', label: uiText('auto.f6fdbe48dc54'), icon: <Trash />, danger: true, enabled: Boolean(presets.active) }
      ])
    ]
    const picked = await api.ui.openMenu(items, { anchor, gap: 4 })
    if (picked === null) return
    if (picked.startsWith('graph:')) presets.select(picked.slice(6))
    else if (picked === 'rename' || picked === 'duplicate') start(picked)
    else if (picked === 'delete' && presets.active) {
      const result = await api.ui.confirm({
        title: uiText('graph.delete.title'),
        message: uiText('graph.delete.message', { p0: presets.active }),
        actions: [
          { label: uiText('auto.77dfd2135f4d'), value: 'cancel', variant: 'ghost' },
          { label: uiText('auto.f6fdbe48dc54'), value: 'delete', variant: 'danger' }
        ]
      })
      if (result === 'delete') presets.remove()
    }
  }

  if (mode !== 'idle') {
    const label = uiText('graph.name')
    return (
      <div className="search-field-row graphview-namebar">
        <div className="graphview-name-cell">
          <div className="search-field graphview-name-field" data-invalid={error ? 'true' : undefined}>
            <GraphIcon className="search-field-icon" />
            <input
              className="search-field-input"
              autoFocus
              spellCheck={false}
              value={draft}
              placeholder={label}
              aria-label={label}
              aria-invalid={Boolean(error)}
              title={error || undefined}
              onChange={(e) => {
                setDraft(e.target.value)
                setError('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') cancel()
              }}
              onBlur={() => {
                if (!closedRef.current && (!draft.trim() || !commit())) cancel()
              }}
            />
            <button
              type="button"
              className="search-field-action"
              aria-label={uiText('auto.77dfd2135f4d')}
              title={uiText('auto.77dfd2135f4d')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancel}
            >
              <X />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="search-field-row graphview-namebar">
      <div className="graphview-name-cell">
        <button
          ref={nameRef}
          type="button"
          className="search-field graphview-name-field"
          data-default={presets.active ? undefined : 'true'}
          aria-haspopup="menu"
          aria-label={uiText('graph.saved', { p0: name })}
          title={uiText('auto.1913d1bc43fa')}
          onClick={() => void openMenu()}
        >
          <GraphIcon className="search-field-icon" />
          <span className="graphview-name-text">{name}</span>
          <ChevronDown className="search-field-icon" />
        </button>
      </div>
      {actions}
      {selectionOnly ? null : <button
        type="button"
        className="panel-tool-btn graphview-new"
        aria-label={uiText('graph.new')}
        title={uiText('graph.new')}
        onClick={() => start('new')}
      >
        <Plus />
      </button>}
    </div>
  )
}
