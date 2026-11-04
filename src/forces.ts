import type { ForceState, GraphData } from './types'

const DAMPING = 0.82
/** Cap per-tick speed so a dense start can't explode the layout. */
const MAX_VELOCITY = 60
/** Barnes-Hut opening angle: far cells (width/distance < THETA) act as one body. */
const THETA = 0.9
const THETA2 = THETA * THETA
/** Coincident points would recurse forever — beyond this depth, bucket them. */
const MAX_DEPTH = 24
/** Seed of the coincident-point jitter, so a layout run is reproducible. */
export const LAYOUT_SEED = 0x2545f491

/**
 * Structure-of-arrays layout state: positions and velocities by node index,
 * pinned flags, and the edges as CSR adjacency (each edge once, under its
 * source, in edge order).
 */
export interface LayoutState {
  n: number
  x: Float64Array
  y: Float64Array
  vx: Float64Array
  vy: Float64Array
  pinned: Uint8Array
  offsets: Uint32Array
  targets: Uint32Array
  seed: number
}

export function createLayoutState(graph: GraphData, seed = LAYOUT_SEED): LayoutState {
  const { nodes, edges } = graph
  const n = nodes.length
  const index = new Map<string, number>(nodes.map((node, i) => [node.id, i]))
  const pairs: [number, number][] = []
  for (const edge of edges) {
    const a = index.get(edge.source)
    const b = index.get(edge.target)
    if (a !== undefined && b !== undefined) pairs.push([a, b])
  }
  const offsets = new Uint32Array(n + 1)
  for (const [a] of pairs) offsets[a + 1]++
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i]
  const fill = offsets.slice(0, n)
  const targets = new Uint32Array(pairs.length)
  for (const [a, b] of pairs) targets[fill[a]++] = b
  const state: LayoutState = {
    n,
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    pinned: new Uint8Array(n),
    offsets,
    targets,
    seed
  }
  nodes.forEach((node, i) => {
    state.x[i] = node.x
    state.y[i] = node.y
    state.vx[i] = node.vx
    state.vy[i] = node.vy
    state.pinned[i] = node.pinned ? 1 : 0
  })
  return state
}

/** xorshift32 in [0, 1). */
function random(state: LayoutState): number {
  let s = state.seed
  s ^= s << 13
  s >>>= 0
  s ^= s >>> 17
  s ^= s << 5
  s >>>= 0
  state.seed = s
  return s / 4294967296
}

/** Index-based Barnes-Hut cells, rebuilt every tick. */
class Tree {
  x0: number[] = []
  y0: number[] = []
  size: number[] = []
  mass: number[] = []
  cx: number[] = []
  cy: number[] = []
  body: number[] = []
  children: number[] = []
  bucket: number[] = []
  split: number[] = []
  next = new Int32Array(0)

  cell(x0: number, y0: number, size: number): number {
    const id = this.size.length
    this.x0.push(x0)
    this.y0.push(y0)
    this.size.push(size)
    this.mass.push(0)
    this.cx.push(0)
    this.cy.push(0)
    this.body.push(-1)
    this.children.push(-1, -1, -1, -1)
    this.bucket.push(-1)
    this.split.push(0)
    return id
  }

  inBucket(cell: number, node: number): boolean {
    for (let i = this.bucket[cell]; i !== -1; i = this.next[i]) if (i === node) return true
    return false
  }
}

function insert(tree: Tree, s: LayoutState, cell: number, node: number, depth: number): void {
  if (tree.mass[cell] === 0 && tree.body[cell] === -1 && !tree.split[cell]) {
    tree.body[cell] = node
    tree.mass[cell] = 1
    tree.cx[cell] = s.x[node]
    tree.cy[cell] = s.y[node]
    return
  }
  if (depth >= MAX_DEPTH) {
    tree.next[node] = tree.bucket[cell]
    tree.bucket[cell] = node
    tree.mass[cell] += 1
    return
  }
  if (!tree.split[cell]) {
    tree.split[cell] = 1
    const prev = tree.body[cell]
    tree.body[cell] = -1
    if (prev !== -1) place(tree, s, cell, prev, depth)
  }
  place(tree, s, cell, node, depth)
  const mass = tree.mass[cell]
  const m = mass + 1
  tree.cx[cell] = (tree.cx[cell] * mass + s.x[node]) / m
  tree.cy[cell] = (tree.cy[cell] * mass + s.y[node]) / m
  tree.mass[cell] = m
}

function place(tree: Tree, s: LayoutState, cell: number, node: number, depth: number): void {
  const half = tree.size[cell] / 2
  const right = s.x[node] >= tree.x0[cell] + half
  const bottom = s.y[node] >= tree.y0[cell] + half
  const slot = cell * 4 + (bottom ? 2 : 0) + (right ? 1 : 0)
  if (tree.children[slot] === -1) {
    tree.children[slot] = tree.cell(tree.x0[cell] + (right ? half : 0), tree.y0[cell] + (bottom ? half : 0), half)
  }
  insert(tree, s, tree.children[slot], node, depth + 1)
}

/**
 * Reference tick on the SoA buffers: centering pull, Barnes-Hut repulsion, link
 * springs, damped integration. `pinnedIndex` (the dragged node, -1 for none)
 * and pinned nodes exert forces but never move. Returns the decayed alpha.
 */
export function layoutTick(s: LayoutState, forces: ForceState, alpha: number, pinnedIndex: number): number {
  const n = s.n
  if (n === 0) return 0
  if (n === 1) {
    s.vx[0] = 0
    s.vy[0] = 0
    return 0
  }
  const center = forces.center * 0.012
  const repel = forces.repel * 2500
  const link = forces.link * 0.04
  const linkDist = forces.linkDistance

  for (let i = 0; i < n; i++) {
    s.vx[i] -= s.x[i] * center * alpha
    s.vy[i] -= s.y[i] * center * alpha
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    if (s.x[i] < minX) minX = s.x[i]
    if (s.y[i] < minY) minY = s.y[i]
    if (s.x[i] > maxX) maxX = s.x[i]
    if (s.y[i] > maxY) maxY = s.y[i]
  }
  const tree = new Tree()
  tree.next = new Int32Array(n).fill(-1)
  tree.cell(minX, minY, Math.max(maxX - minX, maxY - minY, 1))
  for (let i = 0; i < n; i++) insert(tree, s, 0, i, 0)

  const strength = repel * alpha
  const stack: number[] = []
  for (let node = 0; node < n; node++) {
    const nx = s.x[node]
    const ny = s.y[node]
    stack.push(0)
    while (stack.length > 0) {
      const cell = stack.pop()!
      if (tree.mass[cell] === 0) continue
      let dx = nx - tree.cx[cell]
      let dy = ny - tree.cy[cell]
      let d2 = dx * dx + dy * dy
      if (tree.body[cell] === node && tree.mass[cell] === 1) continue
      const leaf = !tree.split[cell]
      const containsNode = !leaf && nx >= tree.x0[cell] && nx < tree.x0[cell] + tree.size[cell] && ny >= tree.y0[cell] && ny < tree.y0[cell] + tree.size[cell]
      if (leaf || (!containsNode && (tree.size[cell] * tree.size[cell]) / d2 < THETA2)) {
        if (d2 < 0.01) {
          dx = (random(s) - 0.5) * 0.1
          dy = (random(s) - 0.5) * 0.1
          d2 = dx * dx + dy * dy
        }
        const mass = tree.body[cell] === node || tree.inBucket(cell, node) ? tree.mass[cell] - 1 : tree.mass[cell]
        if (mass <= 0) continue
        const d = Math.sqrt(d2)
        const f = (strength * mass) / d2
        s.vx[node] += (dx / d) * f
        s.vy[node] += (dy / d) * f
        continue
      }
      for (let k = 0; k < 4; k++) {
        const child = tree.children[cell * 4 + k]
        if (child !== -1) stack.push(child)
      }
    }
  }

  for (let a = 0; a < n; a++) {
    for (let e = s.offsets[a]; e < s.offsets[a + 1]; e++) {
      const b = s.targets[e]
      const dx = s.x[b] - s.x[a]
      const dy = s.y[b] - s.y[a]
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const f = (d - linkDist) * link * alpha
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      s.vx[a] += fx
      s.vy[a] += fy
      s.vx[b] -= fx
      s.vy[b] -= fy
    }
  }

  for (let i = 0; i < n; i++) {
    if (i === pinnedIndex || s.pinned[i]) {
      s.vx[i] = 0
      s.vy[i] = 0
      continue
    }
    s.vx[i] *= DAMPING
    s.vy[i] *= DAMPING
    const speed = Math.sqrt(s.vx[i] * s.vx[i] + s.vy[i] * s.vy[i])
    if (speed > MAX_VELOCITY) {
      s.vx[i] = (s.vx[i] / speed) * MAX_VELOCITY
      s.vy[i] = (s.vy[i] / speed) * MAX_VELOCITY
    }
    s.x[i] += s.vx[i]
    s.y[i] += s.vy[i]
  }
  return alpha * 0.98
}

/**
 * Object-graph adapter over the reference tick: copies node positions into a
 * fresh SoA state, ticks once, and writes them back.
 */
export function tick(graph: GraphData, forces: ForceState, alpha: number, pinnedId?: string | null): number {
  const state = createLayoutState(graph)
  const pinnedIndex = pinnedId == null ? -1 : graph.nodes.findIndex((node) => node.id === pinnedId)
  const next = layoutTick(state, forces, alpha, pinnedIndex)
  graph.nodes.forEach((node, i) => {
    node.x = state.x[i]
    node.y = state.y[i]
    node.vx = state.vx[i]
    node.vy = state.vy[i]
  })
  return next
}
