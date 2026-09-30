import type { NoteDocumentRef } from '@valley/plugin-sdk'

export type GraphNodeKind = 'note' | 'document' | 'tag' | 'attachment' | 'unresolved'

export interface GraphNode {
  /** Unique id: relPath for files, `tag:<name>` for tag nodes, `??:<name>` for unresolved. */
  id: string
  label: string
  kind: GraphNodeKind
  /** Vault-relative path (empty for tag / unresolved nodes). */
  path: string
  documentRef?: NoteDocumentRef
  tags: string[]
  /** File creation time used only by the one-shot history animation. */
  createdAt?: number
  degree: number
  color?: string
  /** Pinned nodes hold their position; the sim still pulls neighbors along. */
  pinned?: boolean
  // simulation state (mutated in place by the force loop)
  x: number
  y: number
  vx: number
  vy: number
}

export interface GraphEdge {
  source: string
  target: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface FilterRule {
  id: string
  /** Free-text + `tag:` / `path:` operators, `-` negates a token, quotes keep spaces. */
  query: string
  /** Subtract the matches instead of starting from them. */
  exclude: boolean
}

export interface FilterState {
  /** Include rows are the base (none = the whole vault); exclude rows subtract from it. */
  rules: FilterRule[]
  showTags: boolean
  showAttachments: boolean
  showOrphans: boolean
  /** Hide links to files that don't exist yet. */
  existingOnly: boolean
}

export interface ColorGroup {
  id: string
  query: string
  color: string
}

export interface DisplayState {
  showArrows: boolean
  nodeSize: number
  linkThickness: number
  /** Hide labels when zoomed out past this scale. */
  textFade: number
  /** Show the color legend over the workspace graph. */
  showLegend: boolean
}

export interface ForceState {
  center: number
  repel: number
  link: number
  /** Rest length of a link spring, in world units. */
  linkDistance: number
}

export interface SourceColorState {
  tags: string
  attachments: string
  orphans: string
  plugins: Record<string, string>
}

export interface GraphConfig {
  plugins: Record<string, boolean>
  sourceColors: SourceColorState
  filters: FilterState
  colorGroups: ColorGroup[]
  display: DisplayState
  forces: ForceState
  /** Local-graph traversal depth from the active file. */
  localDepth: number
}

export interface SavedGraph extends GraphConfig {
  name: string
}

export interface GraphSourcePlugin {
  id: string
  name: string
  version: string
  author: string[]
  nodeTypes: string[]
  linksSourceFiles: boolean
}
