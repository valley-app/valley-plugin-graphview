import { expect, it } from 'vitest'
import { fitCamera } from '../src/GraphCanvas'
import type { GraphNode } from '../src/types'

const node = (id: string, x: number, y: number): GraphNode => ({ id, label: id, kind: 'note', path: `${id}.md`, tags: [], degree: 1, x, y, vx: 0, vy: 0 })
const screen = (camera: { scale: number; x: number; y: number }, n: GraphNode) => ({ x: n.x * camera.scale + camera.x, y: n.y * camera.scale + camera.y })

it('frames the whole graph when no node is centred', () => {
  const nodes = [node('a', 0, 0), node('b', 400, 0), node('c', 400, 300)]
  const camera = fitCamera(nodes, 500, 1000, 1)!
  const left = screen(camera, nodes[0]); const right = screen(camera, nodes[1])
  expect((left.x + right.x) / 2).toBeCloseTo(250, 0)
})

it('keeps the centred node in the middle of the local graph and every neighbour on screen', () => {
  const nodes = [node('Moss Log', 0, 0), node('Lichen Log', 180, 250), node('sample', 420, 400)]
  const camera = fitCamera(nodes, 500, 1070, 1, 'Moss Log')!
  const centre = screen(camera, nodes[0])
  expect(centre.x).toBeCloseTo(250, 5)
  expect(centre.y).toBeCloseTo(535, 5)
  for (const n of nodes) {
    const at = screen(camera, n)
    expect(at.x).toBeGreaterThanOrEqual(0); expect(at.x).toBeLessThanOrEqual(500)
    expect(at.y).toBeGreaterThanOrEqual(0); expect(at.y).toBeLessThanOrEqual(1070)
  }
})

it('falls back to the whole graph while the centred node is not in the data yet', () => {
  const nodes = [node('a', 0, 0), node('b', 400, 0)]
  expect(fitCamera(nodes, 500, 500, 1, 'missing')).toEqual(fitCamera(nodes, 500, 500, 1))
  expect(fitCamera([], 500, 500, 1, 'a')).toBeNull()
})
