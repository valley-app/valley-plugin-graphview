import { createIndexObserver, noteDocumentId, type NoteDocument, type NoteDocumentSource, type ValleyPluginApi } from '@valley/plugin-sdk'
import type { IndexEntry } from '@valley/plugin-sdk/types'

function createOwner(api: ValleyPluginApi, retired: Promise<void> | undefined, onDispose: (pending: Promise<void>) => void) {
  const index = createIndexObserver(api, { fields: ['title', 'kind', 'aliases', 'links', 'tags', 'ctimeMs', 'mtimeMs'] })
  const root = api.getState().vault?.path
  let active = true
  let disposal: Promise<void> | undefined
  let source = index.getSnapshot().entries
  let entries: IndexEntry[] = []
  let documents = { documents: [] as NoteDocument[], sources: [] as NoteDocumentSource[], error: '' }
  const documentListeners = new Set<() => void>()
  const cleanups = new Set<() => void>()
  let documentEpoch = 0
  let documentQueue = Promise.resolve()
  let offDocuments: (() => void) | undefined
  let offLanguage: (() => void) | undefined
  let waiting: { promise: Promise<void>; resolve(): void; reject(error: Error): void } | undefined
  const assertCurrent = (): void => {
    if (!active || api.getState().vault?.path !== root) throw new Error('The graph index session is no longer active.')
  }
  const rejectWaiting = (error: Error): void => { waiting?.reject(error); waiting = undefined }
  const current = (): boolean => { try { assertCurrent(); return true } catch { return false } }
  const publishDocuments = (next: typeof documents): void => {
    if (!current()) return
    documents = next
    for (const listener of documentListeners) listener()
  }
  const enqueueDocuments = (work: (epoch: number) => Promise<void>): void => {
    const accepted = documentEpoch
    documentQueue = documentQueue.then(async () => { if (current() && accepted === documentEpoch) await work(accepted) }).catch(error => {
      if (current() && accepted === documentEpoch) publishDocuments({ ...documents, error: error instanceof Error ? error.message : String(error) })
    })
  }
  const reloadDocuments = async (accepted: number): Promise<void> => {
    const sources = await api.documents.sources()
    if (!current() || accepted !== documentEpoch) return
    publishDocuments({ ...documents, sources, error: '' })
    const next: NoteDocument[] = []
    let cursor: string | undefined
    do {
      const page = await api.documents.query({ limit: 500, cursor })
      if (!current() || accepted !== documentEpoch) return
      next.push(...page.documents)
      cursor = page.cursor
    } while (cursor)
    publishDocuments({ documents: next, sources, error: '' })
  }
  const startDocuments = (): void => {
    if (offDocuments || !current()) return
    offDocuments = api.documents.onChanged(event => {
      if (!current()) return
      if (event.reason === 'inventory') {
        documentEpoch++
        enqueueDocuments(reloadDocuments)
      } else enqueueDocuments(async accepted => {
        const reads = await Promise.allSettled(event.refs.map(async ref => [noteDocumentId(ref), await api.documents.read(ref)] as const))
        if (!current() || accepted !== documentEpoch) return
        const failed = reads.find(read => read.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        const next = new Map(documents.documents.map(document => [document.id, document]))
        for (const read of reads) {
          if (read.status !== 'fulfilled') continue
          const [id, document] = read.value
          if (document) next.set(id, document); else next.delete(id)
        }
        publishDocuments({ ...documents, documents: [...next.values()], error: '' })
      })
    })
    // Source labels come translated from the host, so re-read them in a new language.
    offLanguage = api.ui.onLanguageChanged(() => enqueueDocuments(async (accepted) => {
      const sources = await api.documents.sources()
      if (current() && accepted === documentEpoch) publishDocuments({ ...documents, sources })
    }))
    enqueueDocuments(reloadDocuments)
  }
  const offIndex = index.subscribe(() => {
    const snapshot = index.getSnapshot()
    if (snapshot.status === 'ready') { waiting?.resolve(); waiting = undefined }
    else if (snapshot.status === 'error') rejectWaiting(new Error(snapshot.error ?? 'The graph index is unavailable.'))
  })
  let offVault = (): void => {}
  const owner = {
    api,
    resolve(reference: string): string | null {
      if (!current()) return null
      const wanted = reference.trim().toLowerCase()
      if (!wanted) return null
      const matches = owner.entries().filter(entry => [entry.relPath, entry.title ?? '', entry.relPath.split('/').at(-1)!, ...(entry.aliases ?? [])]
        .some(value => value.toLowerCase() === wanted || value.replace(/\.[^./]+$/, '').toLowerCase() === wanted))
      return (matches.find(entry => /\.(?:md|markdown)$/i.test(entry.relPath)) ?? matches[0])?.relPath ?? null
    },
    getDocuments: () => documents,
    subscribeDocuments(listener: () => void): () => void { documentListeners.add(listener); startDocuments(); return () => { documentListeners.delete(listener) } },
    onDispose(cleanup: () => void): () => void { if (active) cleanups.add(cleanup); else cleanup(); return () => { cleanups.delete(cleanup) } },
    subscribe: index.subscribe,
    entries(): IndexEntry[] {
      const next = index.getSnapshot().entries
      if (source !== next) { source = next; entries = next.map(entry => ({ ...entry, title: entry.title ?? '', kind: entry.kind ?? 'other', mtimeMs: entry.mtimeMs ?? 0 })) }
      return entries
    },
    assertCurrent,
    ready(): Promise<void> {
      try { assertCurrent() } catch (error) { return Promise.reject(error) }
      const snapshot = index.getSnapshot()
      if (snapshot.status === 'ready') return Promise.resolve()
      if (snapshot.status === 'error') return Promise.reject(new Error(snapshot.error ?? 'The graph index is unavailable.'))
      if (!waiting) {
        let resolve!: () => void
        let reject!: (error: Error) => void
        const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
        waiting = { promise, resolve, reject }
      }
      return waiting.promise
    },
    dispose(): Promise<void> {
      if (disposal) return disposal
      active = false
      offIndex(); offVault()
      offDocuments?.(); offLanguage?.(); documentEpoch++; documentListeners.clear()
      for (const cleanup of cleanups) cleanup()
      cleanups.clear()
      rejectWaiting(new Error('The graph index session is no longer active.'))
      disposal = Promise.allSettled([index.dispose(), retired, documentQueue]).then(results => {
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      })
      onDispose(disposal)
      return disposal
    }
  }
  offVault = api.subscribeState(['vault'], ({ state }) => { if (state.vault?.path !== root) void owner.dispose().catch(() => {}) })
  return owner
}

export type GraphIndex = ReturnType<typeof createOwner>
export function getGraphIndex(api: ValleyPluginApi): GraphIndex {
  const holder = api.runtime.getOrCreate<{ current: GraphIndex | null; retiring?: Promise<void> }>('graphView.index', () => ({ current: null }))
  if (!holder.current || holder.current.api !== api) {
    void holder.current?.dispose().catch(() => {})
    const owner = createOwner(api, holder.retiring, pending => {
      if (holder.current === owner) holder.current = null
      holder.retiring = pending
      void pending.catch(() => {})
    })
    holder.current = owner
  }
  return holder.current
}
