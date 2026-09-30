import * as React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { tick } from '../src/forces'
import { GraphCanvas, graphAnimationOrder, graphAnimationSlice, graphEdgeAlphas, graphForcesChanged, graphLabelAlpha, graphNodeColor, graphTopologyChanged, selectVisibleLabels } from '../src/GraphCanvas'
import { buildQuadtree, applyRepulsion } from '../src/quadtree'
import type { ForceState, GraphData, GraphNode } from '../src/types'
import { initRuntime } from '../src/runtime'
import { DEFAULT_CONFIG } from '../src/settings'
import { getGraphIndex } from '../src/indexOwner'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const FORCES: ForceState = { center: 1, repel: 1, link: 1, linkDistance: 75 }

function node(id: string, x: number, y: number): GraphNode {
  return { id, label: id, kind: 'note', path: `${id}.md`, tags: [], degree: 0, x, y, vx: 0, vy: 0 }
}

const dist = (a: GraphNode, b: GraphNode): number => Math.hypot(a.x - b.x, a.y - b.y)

describe('quadtree repulsion', () => {
  it('pushes nearby nodes apart', () => {
    const a = node('a', 0, 0)
    const b = node('b', 4, 0)
    const tree = buildQuadtree([a, b])
    applyRepulsion(tree, a, 100)
    applyRepulsion(tree, b, 100)
    expect(a.vx).toBeLessThan(0)
    expect(b.vx).toBeGreaterThan(0)
  })

  it('handles coincident nodes without NaN', () => {
    const nodes = [node('a', 5, 5), node('b', 5, 5), node('c', 5, 5)]
    const tree = buildQuadtree(nodes)
    for (const n of nodes) applyRepulsion(tree, n, 100)
    for (const n of nodes) {
      expect(Number.isFinite(n.vx)).toBe(true)
      expect(Number.isFinite(n.vy)).toBe(true)
    }
  })

  it('approximates the pairwise force for a far cluster', () => {
    // A tight far-away cluster of 10 should repel roughly like one body of mass 10.
    const probe = node('p', 0, 0)
    const cluster = Array.from({ length: 10 }, (_, i) => node(`c${i}`, 1000 + (i % 3), 1000 + Math.floor(i / 3)))
    const tree = buildQuadtree([probe, ...cluster])
    applyRepulsion(tree, probe, 1)
    const d2 = 1000 * 1000 * 2
    const expected = 10 / d2
    const got = Math.hypot(probe.vx, probe.vy)
    expect(got).toBeGreaterThan(expected * 0.8)
    expect(got).toBeLessThan(expected * 1.2)
  })
})

describe('graph labels', () => {
  it('keeps the highest-priority label and removes collisions', () => {
    const visible = selectVisibleLabels([
      { id: 'background', x: 100, y: 100, width: 80, height: 12, priority: 1 },
      { id: 'hovered', x: 102, y: 101, width: 80, height: 12, priority: 100 },
      { id: 'separate', x: 250, y: 100, width: 80, height: 12, priority: 2 }
    ], 10)

    expect([...visible].sort()).toEqual(['hovered', 'separate'])
  })

  it('caps dense label sets after collision removal', () => {
    const visible = selectVisibleLabels(
      Array.from({ length: 20 }, (_, index) => ({
        id: `n${index}`,
        x: index * 100,
        y: 100,
        width: 40,
        height: 12,
        priority: index
      })),
      6
    )

    expect(visible.size).toBe(6)
    expect(visible.has('n19')).toBe(true)
  })
})

function cameraHarness(data: GraphData) {
  initRuntime(createMockValleyApi({ manifest: { id: 'graphView' } }).api)
  let now = 0
  let sequence = 0
  let width = 800
  let resize = (): void => {}
  const frames = new Map<number, FrameRequestCallback>()
  const arc = vi.fn()
  const context = new Proxy({ arc, measureText: () => ({ width: 40 }) }, {
    get(target, key) { return key in target ? Reflect.get(target, key) : () => {} }
  })
  vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} closePath() {} })
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, width, height: 600, top: 0, left: 0, bottom: 600, right: width, toJSON: () => ({}) }))
  const props = { data, config: DEFAULT_CONFIG, onOpen: () => {}, pins: Object.fromEntries(data.nodes.filter(n => n.pinned).map(n => [n.id, { x: n.x, y: n.y }])) }
  const mounted = render(React.createElement(GraphCanvas, props))
  const canvas = mounted.container.querySelector('canvas')!
  return {
    arc,
    frames,
    canvas,
    step(ms = 16) {
      now += ms
      const pending = [...frames.values()]
      frames.clear()
      arc.mockClear()
      act(() => { for (const frame of pending) frame(now) })
    },
    settle() { for (let i = 0; frames.size && i < 500; i++) this.step() },
    resize(nextWidth: number) { act(() => { width = nextWidth; resize() }) },
    rerender() { mounted.rerender(React.createElement(GraphCanvas, { ...props, data: { nodes: data.nodes.map(n => ({ ...n, color: '#456' })), edges: [...data.edges] } })) }
  }
}

describe('smooth graph camera', () => {
  it('draws a lone node centered from its first frame without drifting or flickering', () => {
    const single = node('single', 320, -170)
    const view = cameraHarness({ nodes: [single], edges: [] })
    for (let i = 0; view.frames.size && i < 100; i++) {
      view.step()
      expect(view.arc.mock.calls[0].slice(0, 2)).toEqual([400, 300])
    }
    expect(view.frames.size).toBe(0)
    expect([single.x, single.y]).toEqual([320, -170])
    view.rerender()
    view.step()
    expect(view.arc.mock.calls[0].slice(0, 2)).toEqual([400, 300])
    expect(view.frames.size).toBe(0)
  })

  it('accumulates wheel bursts, eases around the cursor, reverses smoothly and leaves the layout asleep', () => {
    const single = node('single', 0, 0)
    const view = cameraHarness({ nodes: [single], edges: [] })
    view.settle()
    view.arc.mockClear()
    const wheel = (deltaY: number): void => { fireEvent.wheel(view.canvas, { clientX: 100, clientY: 100, deltaY }) }
    wheel(100)
    wheel(100)
    expect(view.arc).not.toHaveBeenCalled()
    view.step()
    const [x, y] = view.arc.mock.calls[0]
    const targetX = 100 + 300 * Math.exp(-0.3)
    expect(x).toBeGreaterThan(targetX)
    expect(x).toBeLessThan(400)
    expect((x - 100) / (y - 100)).toBeCloseTo(1.5)
    view.rerender()
    view.settle()
    expect(view.arc.mock.calls[0][0]).toBeCloseTo(targetX)
    wheel(-100)
    view.step()
    expect(view.arc.mock.calls[0][0]).toBeGreaterThan(targetX)
    expect(view.arc.mock.calls[0][0]).toBeLessThan(100 + 300 * Math.exp(-0.15))
    view.settle()
    expect(view.arc.mock.calls[0][0]).toBeCloseTo(100 + 300 * Math.exp(-0.15))
    expect(view.frames.size).toBe(0)
    expect([single.x, single.y]).toEqual([0, 0])
  })

  it.each([[1, 2, 32], [2, 0.1, 60]])('normalizes wheel delta mode %s', (deltaMode, deltaY, pixels) => {
    const view = cameraHarness({ nodes: [node('single', 0, 0)], edges: [] })
    view.settle()
    fireEvent.wheel(view.canvas, { clientX: 100, clientY: 100, deltaMode, deltaY })
    view.settle()
    expect(view.arc.mock.calls[0][0]).toBeCloseTo(100 + 300 * Math.exp(-pixels * 0.0015))
  })

  it('keeps manual zoom through pending layout fitting and a resize', () => {
    const nodes = [node('a', -100, 0), node('b', 100, 0)].map(n => ({ ...n, pinned: true }))
    const view = cameraHarness({ nodes, edges: [{ source: 'a', target: 'b' }] })
    view.step()
    const initialX = view.arc.mock.calls[0][0]
    fireEvent.wheel(view.canvas, { clientX: 400, clientY: 300, deltaY: 200 })
    view.step()
    view.resize(1000)
    view.settle()
    expect(view.arc.mock.calls[0][0]).toBeCloseTo(500 + (initialX - 400) * Math.exp(-0.3))
    expect(view.frames.size).toBe(0)
  })
})

describe('graph visual hierarchy', () => {
  it('suspends offscreen, hidden and zero-size simulation and resumes the same layout until disposal', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'graphView' } })
    initRuntime(mock.api)
    let intersect!: (value: boolean) => void
    let resize!: () => void
    let width = 800
    let visibility: DocumentVisibilityState = 'visible'
    let sequence = 0
    const frames = new Map<number, FrameRequestCallback>()
    const disconnectIntersection = vi.fn()
    const disconnectResize = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) { intersect = value => this.callback([{ target, isIntersecting: value } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() { disconnectIntersection() }
    })
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() { disconnectResize() } })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, width, height: 600, top: 0, left: 0, bottom: 600, right: width, toJSON: () => ({}) }))
    const data: GraphData = { nodes: [node('a', -100, 0), node('b', 100, 0)], edges: [{ source: 'a', target: 'b' }] }
    const mounted = render(React.createElement(GraphCanvas, { data, config: DEFAULT_CONFIG, onOpen: () => {} }))
    expect(frames.size).toBe(0)
    act(() => intersect(true))
    expect(frames.size).toBe(1)
    const frame = [...frames.values()][0]
    act(() => intersect(false))
    const before = data.nodes.map(value => [value.x, value.y])
    act(() => frame(16))
    expect(data.nodes.map(value => [value.x, value.y])).toEqual(before)
    expect(frames.size).toBe(0)
    act(() => intersect(true))
    act(() => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')) })
    expect(frames.size).toBe(0)
    act(() => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')) })
    expect(frames.size).toBe(1)
    act(() => { width = 0; resize() })
    expect(frames.size).toBe(0)
    act(() => { width = 800; resize() })
    expect(frames.size).toBe(1)
    const resumed = [...frames.values()][0]
    frames.clear()
    act(() => resumed(32))
    expect(data.nodes.map(value => [value.x, value.y])).not.toEqual(before)
    await act(async () => { await getGraphIndex(mock.api).dispose() })
    expect(frames.size).toBe(0)
    expect(disconnectIntersection).toHaveBeenCalledOnce()
    expect(disconnectResize).toHaveBeenCalledOnce()
    mounted.unmount()
    expect(disconnectIntersection).toHaveBeenCalledOnce()
    expect(disconnectResize).toHaveBeenCalledOnce()
  })

  it('stops idle frames, redraws metadata without moving nodes, reheats rewired edges, and cancels on unmount', () => {
    initRuntime(createMockValleyApi({ manifest: { id: 'graphView' } }).api)
    let now = 0
    let sequence = 0
    const frames = new Map<number, FrameRequestCallback>()
    const disconnected = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() { disconnected() } })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800, toJSON: () => ({}) })
    const step = (): void => {
      now += 16
      const pending = [...frames.values()]
      frames.clear()
      act(() => { for (const frame of pending) frame(now) })
    }
    const initial: GraphData = { nodes: [node('a', -100, 0), node('b', 100, 0), node('c', 0, 100)], edges: [{ source: 'a', target: 'b' }] }
    const props = { config: DEFAULT_CONFIG, onOpen: () => {} }
    const mounted = render(React.createElement(GraphCanvas, { ...props, data: initial }))
    for (let index = 0; frames.size && index < 500; index++) step()
    expect(frames.size).toBe(0)
    const positions = initial.nodes.map(value => [value.x, value.y])
    const recolored = { nodes: initial.nodes.map(value => ({ ...value, color: '#456' })), edges: [...initial.edges] }
    mounted.rerender(React.createElement(GraphCanvas, { ...props, data: recolored }))
    step()
    expect(frames.size).toBe(0)
    expect(recolored.nodes.map(value => [value.x, value.y])).toEqual(positions)
    mounted.rerender(React.createElement(GraphCanvas, { ...props, data: { ...recolored, edges: [{ source: 'a', target: 'c' }] } }))
    step()
    expect(frames.size).toBe(1)
    expect(recolored.nodes.map(value => [value.x, value.y])).not.toEqual(positions)
    mounted.unmount()
    expect(frames.size).toBe(0)
    expect(disconnected).toHaveBeenCalled()
  })

  it('reheats changed link endpoints but keeps reordered or restyled topology asleep', () => {
    const original: GraphData = { nodes: [node('a', 1, 2), node('b', 3, 4), node('c', 5, 6)], edges: [{ source: 'a', target: 'b' }] }
    expect(graphTopologyChanged(original, { ...original, edges: [{ source: 'a', target: 'c' }] })).toBe(true)
    expect(graphTopologyChanged(original, { ...original, edges: [{ source: 'b', target: 'a' }] })).toBe(true)
    expect(graphTopologyChanged(original, { nodes: [...original.nodes].reverse().map(value => ({ ...value, x: 100, color: '#456' })), edges: [...original.edges] })).toBe(false)
    expect(graphTopologyChanged(undefined, original)).toBe(true)
  })

  it('replays dated nodes oldest-first and reveals only complete edges', () => {
    const oldest = { ...node('oldest', 0, 0), createdAt: 10 }
    const newest = { ...node('newest', 0, 0), createdAt: 30 }
    const middle = { ...node('middle', 0, 0), createdAt: 20 }
    const undated = node('undated', 0, 0)
    const data: GraphData = {
      nodes: [newest, undated, oldest, middle],
      edges: [
        { source: 'oldest', target: 'middle' },
        { source: 'middle', target: 'newest' },
        { source: 'newest', target: 'undated' }
      ]
    }
    const order = graphAnimationOrder(data)
    expect(order).toEqual(['oldest', 'middle', 'newest', 'undated'])
    expect(graphAnimationSlice(data, order, 2)).toEqual({
      nodes: [oldest, middle],
      edges: [{ source: 'oldest', target: 'middle' }]
    })
  })

  it('uses color groups for resolved nodes and keeps unresolved nodes faint', () => {
    for (const kind of ['note', 'tag', 'attachment'] as const) {
      expect(graphNodeColor(kind, 'neutral', 'faint')).toBe('neutral')
      expect(graphNodeColor(kind, 'neutral', 'faint', 'group')).toBe('group')
    }
    expect(graphNodeColor('unresolved', 'neutral', 'faint', 'group')).toBe('faint')
  })

  it('keeps the resting web visible and strongly isolates hover connections', () => {
    const rest = graphEdgeAlphas(500, 0)
    const hover = graphEdgeAlphas(500, 1)
    expect(rest.base).toBeGreaterThan(0.3)
    expect(hover.active).toBeGreaterThan(0.9)
    expect(hover.dimmed).toBeLessThan(0.04)
  })

  it('removes labels completely at distant zoom levels', () => {
    expect(graphLabelAlpha(1, 0.5)).toBe(0)
    expect(graphLabelAlpha(1.25, 0.5)).toBeGreaterThan(0)
    expect(graphLabelAlpha(1.5, 0.5)).toBe(1)
  })

  it('restarts the layout for every force control, including link distance', () => {
    for (const [key, value] of [
      ['center', 2],
      ['repel', 2],
      ['link', 2],
      ['linkDistance', 140]
    ] as const) {
      expect(graphForcesChanged(FORCES, { ...FORCES, [key]: value })).toBe(true)
    }
    expect(graphForcesChanged(FORCES, { ...FORCES })).toBe(false)
  })
})

describe('tick', () => {
  it('separates overlapping nodes and stays finite on a few hundred nodes', () => {
    const nodes = Array.from({ length: 300 }, (_, i) =>
      node(`n${i}`, Math.cos(i) * 10, Math.sin(i) * 10)
    )
    const edges = Array.from({ length: 200 }, (_, i) => ({ source: `n${i}`, target: `n${i + 50}` }))
    const graph: GraphData = { nodes, edges }
    let alpha = 1
    for (let i = 0; i < 60; i++) alpha = tick(graph, FORCES, alpha)
    expect(alpha).toBeLessThan(1)
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
    // The blob must have expanded well past its 10px seed radius.
    const spread = Math.max(...nodes.map((n) => Math.hypot(n.x, n.y)))
    expect(spread).toBeGreaterThan(30)
  })

  it('pulls linked nodes toward the spring length', () => {
    const a = node('a', -300, 0)
    const b = node('b', 300, 0)
    const graph: GraphData = { nodes: [a, b], edges: [{ source: 'a', target: 'b' }] }
    let alpha = 1
    for (let i = 0; i < 200; i++) alpha = tick(graph, { ...FORCES, center: 0, repel: 0.1 }, alpha)
    expect(dist(a, b)).toBeLessThan(300)
  })

  it('honours the configured link distance', () => {
    const settle = (linkDistance: number): number => {
      const a = node('a', -300, 0)
      const b = node('b', 300, 0)
      const graph: GraphData = { nodes: [a, b], edges: [{ source: 'a', target: 'b' }] }
      let alpha = 1
      for (let i = 0; i < 400; i++) alpha = tick(graph, { ...FORCES, center: 0, repel: 0, linkDistance }, alpha)
      return dist(a, b)
    }
    expect(settle(40)).toBeLessThan(settle(200))
  })

  it('keeps a pinned (dragged) node in place while its neighbor follows', () => {
    const a = node('a', 0, 0)
    const b = node('b', 400, 0)
    const graph: GraphData = { nodes: [a, b], edges: [{ source: 'a', target: 'b' }] }
    let alpha = 1
    for (let i = 0; i < 20; i++) alpha = tick(graph, { ...FORCES, center: 0, repel: 0 }, alpha, 'a')
    expect(a.x).toBe(0)
    expect(a.y).toBe(0)
    expect(a.vx).toBe(0)
    expect(a.vy).toBe(0)
    expect(b.x).toBeLessThan(400)
  })

  it('returns 0 for an empty graph', () => {
    expect(tick({ nodes: [], edges: [] }, FORCES, 1)).toBe(0)
  })
})
