import type { ForceState, GraphData, GraphNode } from './types'
import { applyRepulsion, buildQuadtree } from './quadtree'

const DAMPING = 0.82
/** Cap per-tick speed so a dense start can't explode the layout. */
const MAX_VELOCITY = 60

/**
 * One step of a dependency-free force simulation: centering pull, Barnes-Hut
 * node-node repulsion (scales to thousands of nodes), and link springs.
 * Mutates node positions in place and returns the decayed alpha (the loop
 * stops when alpha is tiny). A `pinnedId` node (being dragged) still exerts
 * forces on the rest but is not integrated itself, so it stays under the
 * pointer while its neighbors get pulled along.
 */
export function tick(graph: GraphData, forces: ForceState, alpha: number, pinnedId?: string | null): number {
  const { nodes, edges } = graph
  const n = nodes.length
  if (n === 0) return 0
  if (n === 1) {
    nodes[0].vx = 0
    nodes[0].vy = 0
    return 0
  }

  const center = forces.center * 0.012
  const repel = forces.repel * 2500
  const link = forces.link * 0.04
  const linkDist = forces.linkDistance

  // Centering toward origin.
  for (const node of nodes) {
    node.vx -= node.x * center * alpha
    node.vy -= node.y * center * alpha
  }

  // Repulsion via Barnes-Hut — one tree per tick, O(n log n).
  const tree = buildQuadtree(nodes)
  const repelAlpha = repel * alpha
  for (const node of nodes) {
    applyRepulsion(tree, node, repelAlpha)
  }

  // Link springs.
  const byId = new Map<string, GraphNode>(nodes.map((node) => [node.id, node]))
  for (const e of edges) {
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const f = (d - linkDist) * link * alpha
    const fx = (dx / d) * f
    const fy = (dy / d) * f
    a.vx += fx
    a.vy += fy
    b.vx -= fx
    b.vy -= fy
  }

  // Integrate. Dragged and pinned nodes exert forces but never move.
  for (const node of nodes) {
    if (node.id === pinnedId || node.pinned) {
      node.vx = 0
      node.vy = 0
      continue
    }
    node.vx *= DAMPING
    node.vy *= DAMPING
    const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy)
    if (speed > MAX_VELOCITY) {
      node.vx = (node.vx / speed) * MAX_VELOCITY
      node.vy = (node.vy / speed) * MAX_VELOCITY
    }
    node.x += node.vx
    node.y += node.vy
  }

  return alpha * 0.98
}
