import type { GraphNode } from './types'

/**
 * Dependency-free Barnes-Hut quadtree for n-body repulsion. Internal nodes
 * aggregate mass + center of mass; far clusters (width/distance < THETA) act as
 * a single body, making one repulsion pass O(n log n) instead of O(n²).
 */
const THETA = 0.9
const THETA2 = THETA * THETA
/** Coincident points would recurse forever — beyond this depth, bucket them. */
const MAX_DEPTH = 24

interface QuadNode {
  x0: number
  y0: number
  /** Side length (cells are square). */
  size: number
  mass: number
  /** Center of mass. */
  cx: number
  cy: number
  body: GraphNode | null
  /** Extra bodies bucketed at MAX_DEPTH (coincident points). */
  bucket: GraphNode[] | null
  children: (QuadNode | null)[] | null
}

function makeCell(x0: number, y0: number, size: number): QuadNode {
  return { x0, y0, size, mass: 0, cx: 0, cy: 0, body: null, bucket: null, children: null }
}

function insert(cell: QuadNode, node: GraphNode, depth: number): void {
  if (cell.mass === 0 && cell.body === null && cell.children === null) {
    cell.body = node
    cell.mass = 1
    cell.cx = node.x
    cell.cy = node.y
    return
  }
  if (depth >= MAX_DEPTH) {
    ;(cell.bucket ??= []).push(node)
    cell.mass += 1
    return
  }
  if (cell.children === null) {
    const prev = cell.body
    cell.body = null
    cell.children = [null, null, null, null]
    if (prev) place(cell, prev, depth)
  }
  place(cell, node, depth)
  // Accumulate mass + center of mass incrementally.
  const m = cell.mass + 1
  cell.cx = (cell.cx * cell.mass + node.x) / m
  cell.cy = (cell.cy * cell.mass + node.y) / m
  cell.mass = m
}

function place(cell: QuadNode, node: GraphNode, depth: number): void {
  const half = cell.size / 2
  const right = node.x >= cell.x0 + half
  const bottom = node.y >= cell.y0 + half
  const i = (bottom ? 2 : 0) + (right ? 1 : 0)
  const children = cell.children!
  if (!children[i]) {
    children[i] = makeCell(cell.x0 + (right ? half : 0), cell.y0 + (bottom ? half : 0), half)
  }
  insert(children[i]!, node, depth + 1)
}

export function buildQuadtree(nodes: GraphNode[]): QuadNode | null {
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x > maxX) maxX = n.x
    if (n.y > maxY) maxY = n.y
  }
  const size = Math.max(maxX - minX, maxY - minY, 1)
  const root = makeCell(minX, minY, size)
  // Seed mass bookkeeping: the first insert path treats an empty cell specially,
  // so just insert sequentially.
  for (const n of nodes) insert(root, n, 0)
  return root
}

/**
 * Add the repulsion this tree exerts on `node` to its velocity. Matches the
 * old pairwise force law: f = strength / d² along the separation vector.
 */
export function applyRepulsion(root: QuadNode | null, node: GraphNode, strength: number): void {
  if (!root) return
  const stack: QuadNode[] = [root]
  while (stack.length > 0) {
    const cell = stack.pop()!
    if (cell.mass === 0) continue
    let dx = node.x - cell.cx
    let dy = node.y - cell.cy
    let d2 = dx * dx + dy * dy

    const isSelfLeaf = cell.body === node && cell.mass === 1
    if (isSelfLeaf) continue

    // Never approximate a cell the node itself sits in — its own mass would
    // skew the center of mass. Descend until it's excluded.
    const containsNode =
      cell.children !== null &&
      node.x >= cell.x0 &&
      node.x < cell.x0 + cell.size &&
      node.y >= cell.y0 &&
      node.y < cell.y0 + cell.size

    // Far enough (or a leaf): treat the cell as one body of `mass`.
    if (cell.children === null || (!containsNode && (cell.size * cell.size) / d2 < THETA2)) {
      if (d2 < 0.01) {
        dx = (Math.random() - 0.5) * 0.1
        dy = (Math.random() - 0.5) * 0.1
        d2 = dx * dx + dy * dy
      }
      // Exclude the node's own contribution when it sits inside this cell.
      const mass = cell.body === node || cell.bucket?.includes(node) ? cell.mass - 1 : cell.mass
      if (mass <= 0) continue
      const d = Math.sqrt(d2)
      const f = (strength * mass) / d2
      node.vx += (dx / d) * f
      node.vy += (dy / d) * f
      continue
    }
    for (const child of cell.children) {
      if (child) stack.push(child)
    }
  }
}
