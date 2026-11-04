import type { ForceState, GraphData, GraphNode } from '../src/types'

/** Fixture graphs for the 200-tick layout goldens. Positions come from a fixed xorshift32 stream, never Math.random. */
export interface LayoutFixture {
  name: string
  graph: () => GraphData
  forces: ForceState
  pinnedIndex: number
}

export const GOLDEN_TICKS = 200
export const GOLDEN_CHECKPOINTS = [1, 50, 100, 200]

const FORCES: ForceState = { center: 1, repel: 1, link: 1, linkDistance: 75 }

function node(id: string, x: number, y: number, pinned = false): GraphNode {
  return { id, label: id, kind: 'note', path: `${id}.md`, tags: [], degree: 0, x, y, vx: 0, vy: 0, ...(pinned ? { pinned } : {}) }
}

function stream(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

export function randomGraph(nodes: number, edges: number, seed: number): GraphData {
  const next = stream(seed)
  const list = Array.from({ length: nodes }, (_, i) => {
    const a = next() * Math.PI * 2
    const r = 40 + next() * 360
    return node(`n${i}`, Math.cos(a) * r, Math.sin(a) * r)
  })
  const links = Array.from({ length: edges }, () => ({ source: `n${Math.floor(next() * nodes)}`, target: `n${Math.floor(next() * nodes)}` }))
  return { nodes: list, edges: links }
}

export const LAYOUT_FIXTURES: LayoutFixture[] = [
  {
    name: 'ring-300',
    graph: () => ({
      nodes: Array.from({ length: 300 }, (_, i) => node(`n${i}`, Math.cos(i) * 10, Math.sin(i) * 10)),
      edges: Array.from({ length: 200 }, (_, i) => ({ source: `n${i}`, target: `n${i + 50}` }))
    }),
    forces: FORCES,
    pinnedIndex: -1
  },
  {
    name: 'coincident-60',
    graph: () => ({
      nodes: [
        ...Array.from({ length: 40 }, (_, i) => node(`c${i}`, 5, 5)),
        ...Array.from({ length: 20 }, (_, i) => node(`o${i}`, i * 13 - 120, (i % 4) * 30 - 45))
      ],
      edges: [
        ...Array.from({ length: 20 }, (_, i) => ({ source: `c${i}`, target: `o${i}` })),
        { source: 'c0', target: 'c1' },
        { source: 'o3', target: 'o3' },
        { source: 'c2', target: 'missing' }
      ]
    }),
    forces: FORCES,
    pinnedIndex: -1
  },
  {
    name: 'pinned-chain-50',
    graph: () => ({
      nodes: Array.from({ length: 50 }, (_, i) => node(`p${i}`, i * 9 - 200, (i % 7) * 11, i === 0)),
      edges: [
        ...Array.from({ length: 49 }, (_, i) => ({ source: `p${i}`, target: `p${i + 1}` })),
        { source: 'p10', target: 'p11' }
      ]
    }),
    forces: { center: 0.5, repel: 1.5, link: 1.2, linkDistance: 60 },
    pinnedIndex: 3
  },
  {
    name: 'random-2000',
    graph: () => randomGraph(2000, 4000, 0x5eed2000),
    forces: { center: 0.5, repel: 2, link: 0.7, linkDistance: 120 },
    pinnedIndex: -1
  }
]

/** One tick implementation driven over the SoA buffers: positions and velocities by node index. */
export interface LayoutDriver {
  tick(alpha: number, pinnedIndex: number): number
  buffers(): { x: Float64Array; y: Float64Array; vx: Float64Array; vy: Float64Array }
}

export interface GoldenRun {
  nodes: number
  alpha: string
  checkpoints: Record<string, string>
}

const hex = (value: number): string => Buffer.from(new Float64Array([value]).buffer).toString('hex')

export function runGolden(fixture: LayoutFixture, driver: LayoutDriver, sha256: (bytes: Uint8Array) => string): GoldenRun {
  const checkpoints: Record<string, string> = {}
  let alpha = 1
  for (let tick = 1; tick <= GOLDEN_TICKS; tick++) {
    alpha = driver.tick(alpha, fixture.pinnedIndex)
    if (GOLDEN_CHECKPOINTS.includes(tick)) {
      const { x, y, vx, vy } = driver.buffers()
      const bytes = new Uint8Array(x.byteLength * 4)
      ;[x, y, vx, vy].forEach((values, i) => bytes.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), i * x.byteLength))
      checkpoints[tick] = sha256(bytes)
    }
  }
  const { x } = driver.buffers()
  return { nodes: x.length, alpha: hex(alpha), checkpoints }
}
