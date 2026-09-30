import type { IndexEntry } from '@valley/plugin-sdk/types'
import type { FilterRule, GraphNode } from './types'

interface Token {
  negate: boolean
  field: 'tag' | 'path' | 'text'
  value: string
}

/** What a query reads from a node or an index entry. */
export type QueryTarget = Pick<GraphNode, 'label' | 'path' | 'tags'>

/** The query syntax, shown as the filter row's placeholder. Deliberately not a
 *  translatable string: `tag:` and `path:` are literal prefixes {@link parse}
 *  matches on, so a translated copy would name fields that do not exist. */
export const QUERY_PLACEHOLDER = 'tag:#note path:folder text'

/** Whitespace separates tokens except inside double quotes, which are dropped:
 *  `path:"Projects/Copper Finch/"` is one path token. */
function split(query: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const char of query.trim()) {
    if (char === '"') quoted = !quoted
    else if (!quoted && /\s/.test(char)) {
      if (current) out.push(current)
      current = ''
    } else current += char
  }
  if (current) out.push(current)
  return out
}

function parse(query: string): Token[] {
  const out: Token[] = []
  for (const raw of split(query)) {
    let rest = raw
    const negate = rest.startsWith('-')
    if (negate) rest = rest.slice(1)
    if (rest.startsWith('tag:')) {
      out.push({ negate, field: 'tag', value: rest.slice(4).replace(/^#/, '').toLowerCase() })
    } else if (rest.startsWith('path:')) {
      out.push({ negate, field: 'path', value: rest.slice(5).toLowerCase() })
    } else {
      out.push({ negate, field: 'text', value: rest.toLowerCase() })
    }
  }
  return out
}

function matchToken(node: QueryTarget, t: Token): boolean {
  if (!t.value) return true
  switch (t.field) {
    case 'tag':
      return node.tags.some((tag) => tag.toLowerCase() === t.value || tag.toLowerCase().startsWith(`${t.value}/`))
    case 'path':
      return node.path.toLowerCase().includes(t.value)
    case 'text':
      return (
        node.label.toLowerCase().includes(t.value) ||
        node.path.toLowerCase().includes(t.value) ||
        node.tags.some((tag) => tag.toLowerCase().includes(t.value))
      )
  }
}

/** Parse once, match many: all tokens must pass (AND). Empty query matches everything. */
export function queryMatcher(query: string): (node: QueryTarget) => boolean {
  const tokens = parse(query)
  return (node) => tokens.every((t) => (t.negate ? !matchToken(node, t) : matchToken(node, t)))
}

export function matchQuery(node: QueryTarget, query: string): boolean {
  return queryMatcher(query)(node)
}

/** A rule with nothing typed in it filters nothing — a half-written row must not empty the graph. */
const isLive = (rule: FilterRule): boolean => rule.query.trim().length > 0

/** True when at least one rule would actually narrow the graph. */
export function hasLiveRules(rules: readonly FilterRule[]): boolean {
  return rules.some(isLive)
}

/**
 * Include rows are the base — OR-ed, and none means the whole vault — then
 * exclude rows are subtracted. Tokens inside one row still AND, so
 * `tag:#x -draft` keeps its meaning as a single row.
 */
export function rulesMatcher(rules: readonly FilterRule[]): (node: QueryTarget) => boolean {
  const live = rules.filter(isLive)
  const includes = live.filter((r) => !r.exclude).map((r) => queryMatcher(r.query))
  const excludes = live.filter((r) => r.exclude).map((r) => queryMatcher(r.query))
  return (node) => (!includes.length || includes.some((match) => match(node))) && !excludes.some((match) => match(node))
}

export interface FilterCounts {
  /** Files the base holds before anything is subtracted. */
  base: number
  /** Files of the base each live exclusion removes, by rule id. */
  excluded: Record<string, number>
}

const entryTarget = (entry: IndexEntry): QueryTarget => ({
  label: entry.title || (entry.relPath.split('/').pop() ?? entry.relPath).replace(/\.[^.]+$/, ''),
  path: entry.relPath,
  tags: entry.tags ?? []
})

/** Vault files in the filter base and removed by each exclusion — tags,
 *  unresolved links and plugin items are not files, so they are not counted. */
export function filterCounts(entries: readonly IndexEntry[], rules: readonly FilterRule[], showAttachments: boolean): FilterCounts {
  const live = rules.filter(isLive)
  const includes = live.filter((r) => !r.exclude).map((r) => queryMatcher(r.query))
  const excludes = live.filter((r) => r.exclude).map((r) => [r.id, queryMatcher(r.query)] as const)
  const excluded: Record<string, number> = Object.fromEntries(excludes.map(([id]) => [id, 0]))
  let base = 0
  for (const entry of entries) {
    if (entry.kind === 'view' || entry.kind === 'other' || (entry.kind === 'asset' && !showAttachments)) continue
    const target = entryTarget(entry)
    if (includes.length && !includes.some((match) => match(target))) continue
    base++
    for (const [id, match] of excludes) if (match(target)) excluded[id]++
  }
  return { base, excluded }
}
