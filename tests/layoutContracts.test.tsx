import * as React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import manifest from '../manifest.json'
import config from '../config.json'
import { initRuntime } from '../src/runtime'
import { registerGraphFence } from '../src/fence'
import { injectStyles } from '../src/styles'
import { GlobalGraphTab } from '../src/GlobalGraph'
import { GraphSearch } from '../src/surfaces'

const declared = { ...manifest, ...config } as unknown as ValleyPluginManifest

afterEach(() => { cleanup(); document.head.querySelectorAll('style[id]').forEach((style) => style.remove()); document.body.innerHTML = '' })

it('lets the graph code block canvas fill the block height', () => {
  const mock = createMockValleyApi({ manifest: declared })
  initRuntime(mock.api)
  const offStyles = injectStyles()
  const dispose = registerGraphFence()
  mock.codeBlockRenderers.get('graph')?.('height: 320', document.createElement('div'), { path: null, meta: null })
  const inner = document.createElement('div')
  inner.className = 'graph-fence-inner'
  const wrap = document.createElement('div')
  wrap.className = 'graphview-canvas-wrap'
  inner.append(wrap)
  document.body.append(inner)
  // The canvas is absolutely positioned inside its wrap, so the wrap only gets a height as a flex item of the block.
  expect(getComputedStyle(inner).display).toBe('flex')
  expect(getComputedStyle(inner).flexDirection).toBe('column')
  expect(getComputedStyle(wrap).flexGrow).toBe('1')
  dispose()
  offStyles()
})

it('shows a plugin documents failure as a compact hint in the Graph tab and in Properties Search', async () => {
  const mock = createMockValleyApi({ manifest: declared, indexEntries: [{ relPath: 'Fern Canopy.md', title: 'Fern Canopy', kind: 'note', mtimeMs: 0, frontmatter: {} }] })
  vi.spyOn(mock.api.documents, 'query').mockRejectedValue(new Error('Plugin UI request timed out (method=api.call timeoutMs=30000)'))
  initRuntime(mock.api)
  const offStyles = injectStyles()
  const { container } = render(React.createElement(React.Fragment, null, React.createElement(GlobalGraphTab), React.createElement(GraphSearch)))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  const alerts = [...container.querySelectorAll('[role="alert"]')]
  expect(alerts).toHaveLength(2)
  for (const alert of alerts) {
    expect(alert.classList.contains('graphview-hint')).toBe(true)
    expect(alert.classList.contains('graphview-alert')).toBe(true)
    expect(getComputedStyle(alert).marginTop).toBe('0px')
    expect(getComputedStyle(alert).flexShrink).toBe('0')
  }
  offStyles()
})
