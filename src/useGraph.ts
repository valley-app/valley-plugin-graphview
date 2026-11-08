import { React, api } from './runtime'
import type { IndexEntry } from '@valley/plugin-sdk/types'
import { type NoteDocument, type NoteDocumentSource } from '@valley/plugin-sdk'
import { createGraphProjection } from './graphModel'
import type { GraphData } from './types'
import { getGraphIndex } from './indexOwner'
import { runtimePaletteSnapshot, subscribeRuntimePalette } from '@valley/plugin-sdk/palette'

export function useGraphProjection(...inputs: Parameters<ReturnType<typeof createGraphProjection>['update']>): GraphData {
  const palette = React.useSyncExternalStore(subscribeRuntimePalette, runtimePaletteSnapshot, runtimePaletteSnapshot)
  const projection = React.useMemo(() => createGraphProjection(), [])
  React.useEffect(() => () => projection.dispose(), [projection])
  return React.useMemo(() => projection.update(...inputs), [...inputs, palette])
}

export function useIndexEntries(): IndexEntry[] {
  const owner = React.useMemo(() => getGraphIndex(api), [])
  return React.useSyncExternalStore(owner.subscribe, owner.entries, owner.entries)
}

/** Realm-relative path of the active workspace file, live. */
export function useActivePath(): string | null {
  const [path, setPath] = React.useState<string | null>(() => api.getState().activePath)
  React.useEffect(() => {
    const owner = api
    const update = (): void => setPath(owner.getState().activePath)
    update()
    return owner.subscribeState(['activePath'], update)
  }, [])
  return path
}

export function useNoteDocuments(): { documents: NoteDocument[]; sources: NoteDocumentSource[]; error: string } {
  const owner = React.useMemo(() => getGraphIndex(api), [])
  return React.useSyncExternalStore(owner.subscribeDocuments, owner.getDocuments, owner.getDocuments)
}
