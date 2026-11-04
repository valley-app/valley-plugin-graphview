import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { createMockValleyApi, loadPackageWasm } from '@valley/plugin-testkit'
import { loadLayoutKernel, type LayoutKernel } from '../src/layout'
import frozen from './fixtures/layout-goldens.json'
import { LAYOUT_FIXTURES, runGolden } from './layoutFixtures'

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
let kernel: LayoutKernel

beforeAll(async () => {
  const module = await loadPackageWasm(process.cwd(), 'layout')
  kernel = await loadLayoutKernel(createMockValleyApi({ manifest: { id: 'graphView' }, wasm: { modules: [module] } }).api)
})

describe('layout kernel parity with the frozen JavaScript goldens', () => {
  it.each(LAYOUT_FIXTURES.map((fixture) => [fixture.name, fixture] as const))('%s: 200 ticks bit-identical', (name, fixture) => {
    const layout = kernel.create()
    layout.load(fixture.graph())
    const run = runGolden(fixture, { tick: (alpha, pinned) => layout.tick(fixture.forces, alpha, pinned), buffers: () => layout.buffers() }, sha256)
    layout.dispose()
    expect(run).toEqual((frozen.goldens as Record<string, unknown>)[name])
  })
})
