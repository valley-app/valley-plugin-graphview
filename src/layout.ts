import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { ForceState, GraphData, GraphNode } from './types'

/** Seed of the coincident-point jitter, so a layout run is reproducible. */
export const LAYOUT_SEED = 0x2545f491
const MODULE_ID = 'layout'

interface KernelExports {
  layout_create(): number
  layout_select(handle: number): number
  layout_destroy(handle: number): void
  layout_resize(nodes: number, edges: number): number
  layout_x(): number
  layout_y(): number
  layout_vx(): number
  layout_vy(): number
  layout_pinned(): number
  layout_offsets(): number
  layout_targets(): number
  layout_forces(center: number, repel: number, link: number, linkDistance: number): void
  layout_seed(seed: number): void
  layout_tick(alpha: number, pinnedIndex: number): number
}

export interface LayoutBuffers {
  x: Float64Array
  y: Float64Array
  vx: Float64Array
  vy: Float64Array
}

/**
 * One force layout in the WebAssembly kernel: structure-of-arrays positions,
 * velocities and pinned flags plus CSR adjacency, in the module's memory.
 */
export interface LayoutHandle {
  readonly size: number
  /** Uploads the topology and the nodes' positions, velocities and pins. */
  load(graph: GraphData): void
  /** Writes the nodes' current positions, velocities and pins into the buffers (same node order as `load`). */
  write(nodes: readonly GraphNode[]): void
  /** Copies the buffers' positions and velocities back onto the nodes (labels, hit-testing). */
  read(nodes: readonly GraphNode[]): void
  buffers(): LayoutBuffers
  /** One tick; `pinnedIndex` is the dragged node (-1 for none). Returns the decayed alpha. */
  tick(forces: ForceState, alpha: number, pinnedIndex: number): number
  dispose(): void
}

export interface LayoutKernel {
  create(): LayoutHandle
}

export class LayoutKernelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LayoutKernelError'
  }
}

function kernelExports(instance: { exports: Record<string, unknown> }): KernelExports {
  const names: (keyof KernelExports)[] = ['layout_create', 'layout_select', 'layout_destroy', 'layout_resize', 'layout_x', 'layout_y', 'layout_vx', 'layout_vy', 'layout_pinned', 'layout_offsets', 'layout_targets', 'layout_forces', 'layout_seed', 'layout_tick']
  for (const name of names) if (typeof instance.exports[name] !== 'function') throw new LayoutKernelError(`layout module lacks ${name}`)
  return instance.exports as unknown as KernelExports
}

/** Instantiates the declared `layout` module through `api.wasm` (the frame's own `/wasm/layout` route). */
export async function loadLayoutKernel(api: Pick<ValleyPluginApi, 'wasm'>): Promise<LayoutKernel> {
  const env: { memory?: WebAssembly.Memory } = {}
  const instance = await api.wasm.instantiate(MODULE_ID, { env })
  const memory = env.memory
  if (!memory) throw new LayoutKernelError('layout module memory was not handed over')
  const k = kernelExports(instance as unknown as { exports: Record<string, unknown> })
  return {
    create(): LayoutHandle {
      const handle = k.layout_create()
      if (!handle) throw new LayoutKernelError('layout module could not create a layout')
      let size = 0
      let views: (LayoutBuffers & { buffer: ArrayBuffer; pinned: Uint8Array; offsets: Uint32Array; targets: Uint32Array }) | null = null
      let pointers: number[] = []
      let edges = 0
      const select = (): void => {
        if (!k.layout_select(handle)) throw new LayoutKernelError('layout was disposed')
      }
      const current = (): NonNullable<typeof views> => {
        if (!views || views.buffer !== memory.buffer) {
          const buffer = memory.buffer
          const [x, y, vx, vy, pinned, offsets, targets] = pointers
          views = {
            buffer,
            x: new Float64Array(buffer, x, size),
            y: new Float64Array(buffer, y, size),
            vx: new Float64Array(buffer, vx, size),
            vy: new Float64Array(buffer, vy, size),
            pinned: new Uint8Array(buffer, pinned, size),
            offsets: new Uint32Array(buffer, offsets, size + 1),
            targets: new Uint32Array(buffer, targets, edges)
          }
        }
        return views
      }
      const write = (nodes: readonly GraphNode[]): void => {
        const v = current()
        for (let i = 0; i < size; i++) {
          const node = nodes[i]
          v.x[i] = node.x
          v.y[i] = node.y
          v.vx[i] = node.vx
          v.vy[i] = node.vy
          v.pinned[i] = node.pinned ? 1 : 0
        }
      }
      return {
        get size() { return size },
        load(graph) {
          const index = new Map<string, number>(graph.nodes.map((node, i) => [node.id, i]))
          const pairs: number[] = []
          for (const edge of graph.edges) {
            const a = index.get(edge.source)
            const b = index.get(edge.target)
            if (a !== undefined && b !== undefined) pairs.push(a, b)
          }
          select()
          if (!k.layout_resize(graph.nodes.length, pairs.length / 2)) throw new LayoutKernelError(`layout of ${graph.nodes.length} nodes and ${pairs.length / 2} edges exceeds the kernel bounds`)
          size = graph.nodes.length
          edges = pairs.length / 2
          pointers = [k.layout_x(), k.layout_y(), k.layout_vx(), k.layout_vy(), k.layout_pinned(), k.layout_offsets(), k.layout_targets()]
          views = null
          const v = current()
          for (let p = 0; p < pairs.length; p += 2) v.offsets[pairs[p] + 1]++
          for (let i = 0; i < size; i++) v.offsets[i + 1] += v.offsets[i]
          const fill = v.offsets.slice(0, size)
          for (let p = 0; p < pairs.length; p += 2) v.targets[fill[pairs[p]]++] = pairs[p + 1]
          write(graph.nodes)
          k.layout_seed(LAYOUT_SEED)
        },
        write,
        read(nodes) {
          const v = current()
          for (let i = 0; i < size; i++) {
            const node = nodes[i]
            node.x = v.x[i]
            node.y = v.y[i]
            node.vx = v.vx[i]
            node.vy = v.vy[i]
          }
        },
        buffers: () => current(),
        tick(forces, alpha, pinnedIndex) {
          select()
          k.layout_forces(forces.center, forces.repel, forces.link, forces.linkDistance)
          return k.layout_tick(alpha, pinnedIndex)
        },
        dispose() {
          k.layout_destroy(handle)
          views = null
          size = 0
        }
      }
    }
  }
}

interface KernelEntry {
  kernel?: LayoutKernel
  failed?: unknown
  pending: Promise<LayoutKernel>
}

const kernels = new WeakMap<object, KernelEntry>()

/** The plugin's one kernel instance per API, loading on first use; every canvas creates its own layout in it. */
export function layoutKernelFor(api: Pick<ValleyPluginApi, 'wasm'>): KernelEntry {
  let entry = kernels.get(api)
  if (!entry) {
    const created: KernelEntry = { pending: loadLayoutKernel(api) }
    created.pending.then((kernel) => { created.kernel = kernel }, (error: unknown) => { created.failed = error })
    kernels.set(api, created)
    entry = created
  }
  return entry
}
