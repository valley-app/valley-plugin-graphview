import { React, api } from './runtime'
import type { ForceState, GraphConfig, GraphData, GraphNode } from './types'
import type { GraphPins } from './settings'
import { readPaletteColor } from '@valley/plugin-sdk/palette'
import { tick } from './forces'
import { uiText } from './localization'
import { getGraphIndex, type GraphIndex } from './indexOwner'

const HOVER_FADE_MS = 150
const FIT_ANIM_MS = 400
const ZOOM_RESPONSE_MS = 65
const FIT_RESPONSE_MS = 120
const MIN_SCALE = 0.05
const MAX_SCALE = 5
const LABEL_MAX_CHARS = 24
const LABEL_COLLISION_PAD = 3

interface Camera {
  scale: number
  x: number
  y: number
}

interface CameraAnim {
  fromX: number
  fromY: number
  fromScale: number
  toX: number
  toY: number
  toScale: number
  start: number
  duration: number
}

interface LabelCandidate {
  id: string
  x: number
  y: number
  width: number
  height: number
  priority: number
}

interface LabelBox {
  left: number
  top: number
  right: number
  bottom: number
}

interface Props {
  data: GraphData
  config: GraphConfig
  /** Node id to emphasise (the active file in a local graph). */
  centerId?: string | null
  onOpen: (path: string, newTab?: boolean) => void
  /** Ask the owner to centre on a node — a navigation, so it enters history. */
  onCenter?: (id: string) => void
  /** Persisted pinned positions (Alt-drag or the context menu pins). */
  pins?: GraphPins
  onTogglePin?: (id: string, pos: { x: number; y: number } | null) => void
  onUnpinAll?: () => void
  /** Increment to replay graph growth from oldest to newest. */
  animationRun?: number
  /** Find matches: drawn at full strength while everything else recedes. */
  highlightIds?: ReadonlySet<string> | null
  /** Node the camera glides to whenever `focusRun` changes. */
  focusId?: string | null
  focusRun?: number
  /** Fit around `centerId` (local neighbourhoods) instead of the whole graph's bounds. */
  centerFit?: boolean
  /** Replaces the filtered-empty message when the owner knows why nothing is drawn. */
  emptyText?: string
}

interface GraphAnimation {
  startedAt: number
  duration: number
  order: string[]
  visibleCount: number
}

// Sub-linear (sqrt) growth: hubs still read as hubs without uniform fat blobs.
const radiusOf = (n: GraphNode, size: number): number =>
  (1.7 + Math.sqrt(Math.min(32, n.degree)) * 0.7) * size

/** Said only once the index is current, so a graph still loading is never reported as filtered empty. */
const EmptyHint = ({ owner, text }: { owner: GraphIndex; text?: string }): ReturnType<typeof React.createElement> | null => {
  const status = React.useSyncExternalStore(owner.subscribe, owner.status, owner.status)
  return status === 'loading' ? null : React.createElement('div', { className: 'graphview-empty' }, text ?? uiText('auto.af410c618763'))
}

/**
 * Camera that frames `nodes` with padding. With `centerId` present in the
 * data, the camera keeps that node in the middle and frames the farthest
 * neighbour on each axis, so a local graph re-centres on its active file.
 */
export function fitCamera(nodes: readonly GraphNode[], w: number, h: number, nodeSize: number, centerId?: string | null): { scale: number; x: number; y: number } | null {
  if (nodes.length === 0 || w === 0 || h === 0) return null
  const focus = centerId ? nodes.find((n) => n.id === centerId) : undefined
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    const r = radiusOf(n, nodeSize)
    if (n.x - r < minX) minX = n.x - r
    if (n.y - r < minY) minY = n.y - r
    if (n.x + r > maxX) maxX = n.x + r
    if (n.y + r > maxY) maxY = n.y + r
  }
  const cx = focus ? focus.x : (minX + maxX) / 2
  const cy = focus ? focus.y : (minY + maxY) / 2
  const pad = 24
  const bw = Math.max(focus ? 2 * Math.max(cx - minX, maxX - cx) : maxX - minX, 1)
  const bh = Math.max(focus ? 2 * Math.max(cy - minY, maxY - cy) : maxY - minY, 1)
  const fitScale = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)
  const scale = clamp(fitScale * (focus ? 1 : 1.04), MIN_SCALE, MAX_SCALE)
  return { scale, x: w / 2 - cx * scale, y: h / 2 - cy * scale }
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

const ellipsize = (s: string): string =>
  s.length > LABEL_MAX_CHARS ? `${s.slice(0, LABEL_MAX_CHARS - 1)}…` : s

export const graphNodeColor = (kind: GraphNode['kind'], nodeColor: string, faint: string, custom?: string): string =>
  kind === 'unresolved' ? faint : custom ?? nodeColor

export const graphForcesChanged = (previous: ForceState, next: ForceState): boolean =>
  previous.center !== next.center ||
  previous.repel !== next.repel ||
  previous.link !== next.link ||
  previous.linkDistance !== next.linkDistance

export function graphTopologyChanged(previous: GraphData | undefined, next: GraphData): boolean {
  if (!previous || previous.nodes.length !== next.nodes.length || previous.edges.length !== next.edges.length) return true
  const nodes = new Set(previous.nodes.map(node => node.id))
  const edges = new Set(previous.edges.map(edge => JSON.stringify([edge.source, edge.target])))
  return next.nodes.some(node => !nodes.has(node.id)) || next.edges.some(edge => !edges.has(JSON.stringify([edge.source, edge.target])))
}

export function graphEdgeAlphas(edgeCount: number, hover: number): { base: number; active: number; dimmed: number } {
  const density = clamp(1 - edgeCount / 6000, 0.6, 1)
  const base = 0.4 * density
  return {
    base,
    active: base + (0.96 - base) * hover,
    dimmed: base * (1 - 0.92 * hover)
  }
}

export const graphLabelAlpha = (scale: number, fade: number): number =>
  clamp((scale - (0.65 + fade)) / 0.35, 0, 1)

export function graphAnimationOrder(data: GraphData): string[] {
  return [...data.nodes]
    .sort((a, b) => {
      const aTime = a.createdAt && Number.isFinite(a.createdAt) ? a.createdAt : Number.MAX_SAFE_INTEGER
      const bTime = b.createdAt && Number.isFinite(b.createdAt) ? b.createdAt : Number.MAX_SAFE_INTEGER
      return aTime - bTime || a.id.localeCompare(b.id)
    })
    .map((node) => node.id)
}

export function graphAnimationSlice(data: GraphData, order: readonly string[], visibleCount: number): GraphData {
  const visible = new Set(order.slice(0, Math.max(0, visibleCount)))
  return {
    nodes: data.nodes.filter((node) => visible.has(node.id)),
    edges: data.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target))
  }
}

const overlaps = (a: LabelBox, b: LabelBox): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

export function selectVisibleLabels(candidates: LabelCandidate[], limit: number): Set<string> {
  const visible = new Set<string>()
  const boxes: LabelBox[] = []
  const ordered = [...candidates].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  for (const candidate of ordered) {
    if (visible.size >= limit) break
    const box = {
      left: candidate.x - candidate.width / 2 - LABEL_COLLISION_PAD,
      top: candidate.y - LABEL_COLLISION_PAD,
      right: candidate.x + candidate.width / 2 + LABEL_COLLISION_PAD,
      bottom: candidate.y + candidate.height + LABEL_COLLISION_PAD
    }
    if (boxes.some((placed) => overlaps(box, placed))) continue
    visible.add(candidate.id)
    boxes.push(box)
  }
  return visible
}

/**
 * Canvas force-graph: pan (drag bg), zoom (wheel), drag nodes, click
 * to open, animated hover highlighting, optional link arrows, zoom-to-fit.
 * Rendering is O(nodes + edges) per frame; ecology is Barnes-Hut.
 */
export const GraphCanvas = ({
  data,
  config,
  centerId,
  onOpen,
  onCenter,
  pins,
  onTogglePin,
  onUnpinAll,
  animationRun,
  highlightIds,
  focusId,
  focusRun,
  centerFit,
  emptyText
}: Props): ReturnType<typeof React.createElement> => {
  const [owner] = React.useState(() => getGraphIndex(api))
  const [openError, setOpenError] = React.useState('')
  const openNode = (node: GraphNode, newTab?: boolean): void => {
    try { owner.assertCurrent() } catch { return }
    setOpenError('')
    if (node.documentRef) {
      void owner.api.documents.open(node.documentRef).then((opened) => {
        try { owner.assertCurrent(); if (!opened) setOpenError(uiText('surface.unavailable')) } catch {}
      }).catch(() => { try { owner.assertCurrent(); setOpenError(uiText('surface.unavailable')) } catch {} })
    } else if (node.path) onOpen(node.path, newTab)
  }
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const cameraRef = React.useRef<Camera>({ scale: 1, x: 0, y: 0 })
  const camAnimRef = React.useRef<CameraAnim | null>(null)
  const zoomTargetRef = React.useRef<Camera | null>(null)
  const initialFitRef = React.useRef(true)
  const centerRef = React.useRef(centerId)
  centerRef.current = centerId
  const centerFitRef = React.useRef(centerFit)
  centerFitRef.current = centerFit
  const posRef = React.useRef<Map<string, { x: number; y: number; vx: number; vy: number }>>(new Map())
  const dataRef = React.useRef<GraphData>(data)
  const animationRef = React.useRef<GraphAnimation | null>(null)
  const alphaRef = React.useRef(1)
  const rafRef = React.useRef<number | null>(null)
  const frameViewRef = React.useRef<Window | null>(null)
  const lastTimeRef = React.useRef(0)
  const hoverRef = React.useRef<{ id: string | null; t: number }>({ id: null, t: 0 })
  const neighborsRef = React.useRef<Set<string>>(new Set())
  const dragRef = React.useRef<{
    id: string | null
    startX: number
    startY: number
    moved: boolean
    alt: boolean
  } | null>(null)
  const sizeRef = React.useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const intersectingRef = React.useRef(typeof IntersectionObserver === 'undefined')
  const pausedAtRef = React.useRef<number | null>(null)
  const pendingFitRef = React.useRef(true)
  const prevCenterRef = React.useRef<string | null | undefined>(centerId)
  const configRef = React.useRef(config)
  configRef.current = config
  const pinsRef = React.useRef<GraphPins>(pins ?? {})
  pinsRef.current = pins ?? {}
  const onTogglePinRef = React.useRef(onTogglePin)
  onTogglePinRef.current = onTogglePin
  const onUnpinAllRef = React.useRef(onUnpinAll)
  onUnpinAllRef.current = onUnpinAll
  const onCenterRef = React.useRef(onCenter)
  onCenterRef.current = onCenter
  const findRef = React.useRef<{ ids: ReadonlySet<string> | null; focus: string | null }>({ ids: null, focus: null })
  findRef.current = { ids: highlightIds ?? null, focus: focusId ?? null }

  const visibleGraph = React.useCallback((): GraphData => {
    const animation = animationRef.current
    return animation
      ? graphAnimationSlice(dataRef.current, animation.order, animation.visibleCount)
      : dataRef.current
  }, [])

  const drawable = React.useCallback((): boolean => {
    try { owner.assertCurrent() } catch { return false }
    return Boolean(canvasRef.current && intersectingRef.current && canvasRef.current.ownerDocument.visibilityState !== 'hidden' && sizeRef.current.w > 0 && sizeRef.current.h > 0)
  }, [owner])
  const stopRunning = React.useCallback((): void => {
    if (rafRef.current !== null) frameViewRef.current?.cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    pausedAtRef.current ??= performance.now()
  }, [])

  const draw = React.useCallback((): void => {
    if (!drawable()) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const { w, h } = sizeRef.current
    const cam = cameraRef.current
    const centerId = centerRef.current
    const cfg = configRef.current
    const graph = visibleGraph()
    const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const styles = getComputedStyle(canvas)
    // Labels take the brightest text tone rather than a muted one — a name over
    // a dark canvas is the thing you read, not chrome.
    const textColor = styles.getPropertyValue('--title-color')?.trim() || styles.color || '#999'
    const nodeColor = styles.getPropertyValue('--text-secondary')?.trim() || textColor
    const faint = styles.getPropertyValue('--text-tertiary')?.trim() || nodeColor
    const muted = nodeColor
    const accent = styles.getPropertyValue('--accent-color')?.trim() || '#8b5cf6'

    const toScreenX = (x: number): number => x * cam.scale + cam.x
    const toScreenY = (y: number): number => y * cam.scale + cam.y

    const byId = new Map<string, GraphNode>()
    for (const n of graph.nodes) byId.set(n.id, n)

    const { id: hoverId, t: hoverT } = hoverRef.current
    const highlighting = hoverT > 0.001
    const neighbors = neighborsRef.current
    const { ids: found, focus } = findRef.current
    const findDim = found && !highlighting ? 0.3 : 1

    // ---- Edges: batch into highlighted / dimmed groups (two strokes total) ----
    // Dense graphs get fainter edges so structure stays readable.
    const { active: activeAlpha, dimmed: dimmedAlpha } = graphEdgeAlphas(graph.edges.length, hoverT)
    const activePath = new Path2D()
    const dimmedPath = new Path2D()
    const drawArrows = cfg.display.showArrows && cam.scale >= 0.45
    const activeArrows = drawArrows ? new Path2D() : null
    const dimmedArrows = drawArrows ? new Path2D() : null

    for (const e of graph.edges) {
      const a = byId.get(e.source)
      const b = byId.get(e.target)
      if (!a || !b) continue
      const isActive = highlighting && (e.source === hoverId || e.target === hoverId)
      const path = isActive ? activePath : dimmedPath
      const ax = toScreenX(a.x)
      const ay = toScreenY(a.y)
      const bx = toScreenX(b.x)
      const by = toScreenY(b.y)
      path.moveTo(ax, ay)
      path.lineTo(bx, by)

      if (drawArrows) {
        const dx = bx - ax
        const dy = by - ay
        const d = Math.sqrt(dx * dx + dy * dy)
        const rb = radiusOf(b, cfg.display.nodeSize) * clamp(cam.scale, 0.15, 2.2)
        if (d > rb + 8) {
          const ux = dx / d
          const uy = dy / d
          const tipX = bx - ux * (rb + 2)
          const tipY = by - uy * (rb + 2)
          const size = 3 + cfg.display.linkThickness * 1.6
          const arrows = isActive ? activeArrows! : dimmedArrows!
          arrows.moveTo(tipX, tipY)
          arrows.lineTo(tipX - ux * size - uy * size * 0.55, tipY - uy * size + ux * size * 0.55)
          arrows.lineTo(tipX - ux * size + uy * size * 0.55, tipY - uy * size - ux * size * 0.55)
          arrows.closePath()
        }
      }
    }

    ctx.lineWidth = Math.max(0.4, cfg.display.linkThickness * 0.65)
    ctx.strokeStyle = muted
    ctx.globalAlpha = Math.max(0, dimmedAlpha) * findDim
    ctx.stroke(dimmedPath)
    if (drawArrows) {
      ctx.fillStyle = muted
      ctx.fill(dimmedArrows!)
    }
    if (highlighting) {
      ctx.strokeStyle = accent
      ctx.globalAlpha = activeAlpha
      ctx.stroke(activePath)
      if (drawArrows) {
        ctx.fillStyle = accent
        ctx.fill(activeArrows!)
      }
    }
    ctx.globalAlpha = 1

    // ---- Nodes + labels ----
    const fade = cfg.display.textFade
    // Plain notes fade in late and steeply; hubs surface much earlier, so a
    // zoomed-out dense graph shows only the important names — no gray mush.
    const labelAlpha = graphLabelAlpha(cam.scale, fade)
    const hubLabelAlpha = clamp(labelAlpha * 1.12, 0, 1)
    const fontSize = 10.5 * clamp(cam.scale, 0.9, 1.2)
    ctx.font = `${fontSize}px -apple-system, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    // Halo behind label text so names stay readable over edges/nodes.
    const halo = styles.getPropertyValue('--surface-color-alt')?.trim() || '#ffffff'
    ctx.lineJoin = 'round'

    const labelCandidates: LabelCandidate[] = []
    const labelById = new Map<string, { node: GraphNode; label: string; x: number; y: number; alpha: number; active: boolean }>()

    for (const n of graph.nodes) {
      const sx = toScreenX(n.x)
      const sy = toScreenY(n.y)
      const r = radiusOf(n, cfg.display.nodeSize) * clamp(cam.scale, 0.15, 2.2)
      const isHovered = n.id === hoverId
      const isNear = isHovered || neighbors.has(n.id)
      const isFocused = n.id === focus
      const isFound = Boolean(found?.has(n.id))
      const dimT = highlighting && !isNear ? hoverT : 0
      const nodeAlpha = isFocused || isNear ? 1 : (1 - 0.9 * dimT) * (found && !isFound ? 0.15 : 1)
      const color = n.id === centerId || isFocused ? accent : graphNodeColor(n.kind, nodeColor, faint, n.color ? readPaletteColor(n.color) : undefined)
      ctx.globalAlpha = isHovered ? 1 : nodeAlpha
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      if (n.kind === 'unresolved') {
        ctx.strokeStyle = isHovered ? accent : color
        ctx.lineWidth = 1
        ctx.stroke()
      } else {
        ctx.fillStyle = isHovered ? accent : color
        ctx.fill()
      }
      if (centerId && n.id === centerId) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = accent
        ctx.lineWidth = 2
        ctx.stroke()
      }
      if (n.pinned) {
        ctx.globalAlpha = nodeAlpha * 0.7
        ctx.strokeStyle = textColor
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(sx, sy, r + 2.5, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = nodeAlpha
      }
      if ((isFound || isFocused) && !isHovered) {
        ctx.globalAlpha = 1
        ctx.strokeStyle = accent
        ctx.lineWidth = n.id === focus ? 3 : 1.5
        ctx.beginPath()
        ctx.arc(sx, sy, r + 3, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = nodeAlpha
      }
      if (isHovered && hoverT > 0.01) {
        ctx.globalAlpha = hoverT
        ctx.strokeStyle = accent
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(sx, sy, r + 3, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = nodeAlpha
      }

      const zoomAlpha = n.degree >= 6 ? hubLabelAlpha : labelAlpha
      const active = isHovered || (highlighting && neighbors.has(n.id)) || isFound
      const thisLabelAlpha = active
        ? Math.max(zoomAlpha, isFound ? 0.95 : hoverT)
        : zoomAlpha * (highlighting ? 1 - 0.95 * hoverT : 0.78) * (found ? 0.25 : 1)
      if (thisLabelAlpha <= 0.02) continue
      const label = ellipsize(n.label)
      const y = sy + r + 2
      const priority =
        (isHovered ? 1_000_000 : 0) +
        (centerId === n.id || n.id === focus ? 500_000 : 0) +
        (isFound ? 200_000 : 0) +
        (active ? 100_000 : 0) +
        n.degree * 100 - Math.hypot(sx - w / 2, sy - h / 2) * 0.01
      labelCandidates.push({
        id: n.id,
        x: sx,
        y,
        width: ctx.measureText(label).width,
        height: fontSize + 2,
        priority
      })
      labelById.set(n.id, { node: n, label, x: sx, y, alpha: thisLabelAlpha, active })
    }

    const labelLimit = Math.max(16, Math.floor((w * h) / (highlighting ? 8500 : 6800)))
    const visibleLabels = selectVisibleLabels(labelCandidates, labelLimit)
    const orderedLabels = labelCandidates.sort((a, b) => a.priority - b.priority)
    for (const candidate of orderedLabels) {
      if (!visibleLabels.has(candidate.id)) continue
      const rendered = labelById.get(candidate.id)
      if (!rendered) continue
      ctx.globalAlpha = rendered.alpha * (rendered.active ? 0.92 : 0.72)
      ctx.strokeStyle = halo
      ctx.lineWidth = 3.2
      ctx.strokeText(rendered.label, rendered.x, rendered.y)
      ctx.globalAlpha = rendered.alpha
      ctx.fillStyle = textColor
      ctx.fillText(rendered.label, rendered.x, rendered.y)
    }
    ctx.globalAlpha = 1
  }, [visibleGraph, drawable])

  /** Animate camera to frame all nodes (with padding), or the centred node's neighbourhood around it. */
  const fitView = React.useCallback((animate: boolean, blend = 1): void => {
    const { w, h } = sizeRef.current
    const target = fitCamera(dataRef.current.nodes, w, h, configRef.current.display.nodeSize, centerFitRef.current ? centerRef.current : null)
    if (!target) return
    const { scale: toScale, x: toX, y: toY } = target
    const cam = cameraRef.current
    zoomTargetRef.current = null
    if (!animate) {
      cam.scale += (toScale - cam.scale) * blend
      cam.x += (toX - cam.x) * blend
      cam.y += (toY - cam.y) * blend
      camAnimRef.current = null
      return
    }
    camAnimRef.current = {
      fromX: cam.x,
      fromY: cam.y,
      fromScale: cam.scale,
      toX,
      toY,
      toScale,
      start: performance.now(),
      duration: FIT_ANIM_MS
    }
  }, [])

  const ensureRunning = React.useCallback((): void => {
    if (!drawable()) { stopRunning(); return }
    if (pausedAtRef.current !== null) {
      const resumedAt = performance.now()
      const paused = resumedAt - pausedAtRef.current
      if (animationRef.current) animationRef.current.startedAt += Math.min(paused, resumedAt - animationRef.current.startedAt)
      if (camAnimRef.current) camAnimRef.current.start += Math.min(paused, resumedAt - camAnimRef.current.start)
      pausedAtRef.current = null
    }
    if (initialFitRef.current && dataRef.current.nodes.length > 0) {
      fitView(false)
      initialFitRef.current = false
    }
    if (rafRef.current != null) return
    const view = canvasRef.current?.ownerDocument.defaultView
    if (!view) return
    frameViewRef.current = view
    lastTimeRef.current = performance.now()
    const loop = (): void => {
      if (!drawable()) { stopRunning(); return }
      const now = performance.now()
      let again = false
      const dt = Math.max(0, now - lastTimeRef.current)
      lastTimeRef.current = now

      const animation = animationRef.current
      if (animation) {
        const progress = clamp((now - animation.startedAt) / animation.duration, 0, 1)
        const nextCount = Math.max(1, Math.ceil(progress * animation.order.length))
        if (nextCount !== animation.visibleCount) {
          animation.visibleCount = nextCount
          alphaRef.current = Math.max(alphaRef.current, 0.45)
        }
        if (progress >= 1) animationRef.current = null
        else again = true
      }

      // Camera animation.
      const anim = camAnimRef.current
      if (anim) {
        const t = clamp((now - anim.start) / anim.duration, 0, 1)
        const k = easeOutCubic(t)
        const cam = cameraRef.current
        cam.x = anim.fromX + (anim.toX - anim.fromX) * k
        cam.y = anim.fromY + (anim.toY - anim.fromY) * k
        cam.scale = anim.fromScale + (anim.toScale - anim.fromScale) * k
        if (t >= 1) {
          camAnimRef.current = null
        } else again = true
      }

      const zoom = zoomTargetRef.current
      if (zoom) {
        const cam = cameraRef.current
        const blend = 1 - Math.exp(-dt / ZOOM_RESPONSE_MS)
        cam.x += (zoom.x - cam.x) * blend
        cam.y += (zoom.y - cam.y) * blend
        cam.scale += (zoom.scale - cam.scale) * blend
        if (Math.abs(zoom.scale - cam.scale) < 0.0001 && Math.hypot(zoom.x - cam.x, zoom.y - cam.y) < 0.05) {
          Object.assign(cam, zoom)
          zoomTargetRef.current = null
        } else again = true
      }

      // Hover highlight fade.
      const hover = hoverRef.current
      const target = hover.id ? 1 : 0
      if (hover.t !== target) {
        const step = dt / HOVER_FADE_MS
        hover.t = hover.t < target ? Math.min(target, hover.t + step) : Math.max(target, hover.t - step)
        if (hover.t !== target) again = true
      }

      // Ecology.
      if (alphaRef.current > 0.02) {
        const graph = visibleGraph()
        alphaRef.current = tick(
          graph,
          configRef.current.forces,
          alphaRef.current,
          dragRef.current?.id ?? null
        )
        // sync positions back into the persistent store
        for (const n of graph.nodes) {
          posRef.current.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy })
        }
        again = true
        if (pendingFitRef.current) fitView(false, 1 - Math.exp(-dt / FIT_RESPONSE_MS))
        if (pendingFitRef.current && alphaRef.current < 0.05) {
          pendingFitRef.current = false
          fitView(true)
        }
      } else if (pendingFitRef.current) {
        pendingFitRef.current = false
        fitView(true)
        again = true
      }

      draw()
      if (again) rafRef.current = view.requestAnimationFrame(loop)
      else rafRef.current = null
    }
    rafRef.current = view.requestAnimationFrame(loop)
  }, [draw, fitView, visibleGraph, drawable, stopRunning])

  const kick = React.useCallback((): void => {
    alphaRef.current = Math.max(alphaRef.current, 0.6)
    ensureRunning()
  }, [ensureRunning])

  const topoRef = React.useRef<GraphData>()

  // Seed/restore positions whenever the data prop changes. Only reheat the
  // simulation when the topology actually changed — index reloads triggered by
  // unrelated vault writes (autosave, todos, …) must not make the layout boil.
  // Pins win over remembered sim positions; unpinned nodes rejoin the sim.
  const applyPins = React.useCallback((): void => {
    for (const n of dataRef.current.nodes) {
      const pin = pinsRef.current[n.id]
      if (pin) {
        n.pinned = true
        n.x = pin.x
        n.y = pin.y
        n.vx = 0
        n.vy = 0
        posRef.current.set(n.id, { x: pin.x, y: pin.y, vx: 0, vy: 0 })
      } else if (n.pinned) {
        n.pinned = false
      }
    }
  }, [])

  React.useEffect(() => {
    const hadNodes = dataRef.current.nodes.length > 0 && posRef.current.size > 0
    for (const n of data.nodes) {
      const prev = posRef.current.get(n.id)
      if (prev) {
        n.x = prev.x
        n.y = prev.y
        n.vx = prev.vx
        n.vy = prev.vy
      } else {
        posRef.current.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy })
      }
    }
    dataRef.current = data
    applyPins()
    // Refit on first load and whenever a local graph recenters on another file.
    if (!hadNodes || prevCenterRef.current !== centerId) {
      pendingFitRef.current = true
    }
    prevCenterRef.current = centerId
    if (hoverRef.current.id && !data.nodes.some((n) => n.id === hoverRef.current.id)) {
      hoverRef.current.id = null
      neighborsRef.current = new Set()
    }
    const topologyChanged = graphTopologyChanged(topoRef.current, data)
    topoRef.current = data
    if (topologyChanged) {
      kick()
    } else {
      ensureRunning()
    }
  }, [data, centerId, kick, ensureRunning, applyPins])

  const previousAnimationRunRef = React.useRef(animationRun)
  React.useEffect(() => {
    if (animationRun === undefined || animationRun === previousAnimationRunRef.current) return
    previousAnimationRunRef.current = animationRun
    const order = graphAnimationOrder(dataRef.current)
    if (order.length < 2) return
    animationRef.current = {
      startedAt: performance.now(),
      duration: Math.min(8000, Math.max(2400, order.length * 16)),
      order,
      visibleCount: 1
    }
    hoverRef.current = { id: null, t: 0 }
    neighborsRef.current = new Set()
    alphaRef.current = 1
    ensureRunning()
  }, [animationRun, ensureRunning])

  // Find: repaint on new matches, and glide to the stepped-to node at a zoom
  // where its label reads. A pending auto-fit must not pull the camera back.
  React.useEffect(() => { ensureRunning() }, [highlightIds, focusId, ensureRunning])
  React.useEffect(() => {
    if (!focusId || !focusRun) return
    const node = dataRef.current.nodes.find((n) => n.id === focusId)
    const { w, h } = sizeRef.current
    if (!node || !w || !h) return
    const cam = cameraRef.current
    const toScale = clamp(Math.max(cam.scale, 1.4), MIN_SCALE, MAX_SCALE)
    pendingFitRef.current = false
    zoomTargetRef.current = null
    camAnimRef.current = {
      fromX: cam.x,
      fromY: cam.y,
      fromScale: cam.scale,
      toX: w / 2 - node.x * toScale,
      toY: h / 2 - node.y * toScale,
      toScale,
      start: performance.now(),
      duration: FIT_ANIM_MS
    }
    ensureRunning()
  }, [focusId, focusRun, ensureRunning])

  // Re-apply pins when they change from outside a drag (menu pin/unpin-all).
  React.useEffect(() => {
    applyPins()
    ensureRunning()
  }, [pins, applyPins, ensureRunning])

  // Repaint on any config change (the loop idles once settled, so a paused
  // canvas would otherwise ignore display/color tweaks); re-layout live when
  // the force sliders move.
  const prevForcesRef = React.useRef(config.forces)
  React.useEffect(() => {
    const prev = prevForcesRef.current
    prevForcesRef.current = config.forces
    if (graphForcesChanged(prev, config.forces)) {
      kick()
    } else {
      ensureRunning()
    }
  }, [config, kick, ensureRunning])

  // Size tracking.
  React.useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const view = canvas.ownerDocument.defaultView as Window & typeof globalThis
    let released = false
    let pendingResize: number | null = null
    const apply = (): void => {
      pendingResize = null
      if (released) return
      try { owner.assertCurrent() } catch { return }
      const rect = wrap.getBoundingClientRect()
      const dpr = view.devicePixelRatio || 1
      const previous = sizeRef.current
      const width = Math.max(1, Math.round(rect.width * dpr))
      const height = Math.max(1, Math.round(rect.height * dpr))
      if (previous.w === rect.width && previous.h === rect.height && canvas.width === width && canvas.height === height) return
      sizeRef.current = { w: rect.width, h: rect.height }
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      const cam = cameraRef.current
      if (previous.w > 0 && previous.h > 0) {
        const dx = (rect.width - previous.w) / 2
        const dy = (rect.height - previous.h) / 2
        cam.x += dx
        cam.y += dy
        const zoom = zoomTargetRef.current
        if (zoom) { zoom.x += dx; zoom.y += dy }
        const anim = camAnimRef.current
        if (anim) { anim.fromX += dx; anim.toX += dx; anim.fromY += dy; anim.toY += dy }
      } else if (cam.x === 0 && cam.y === 0) {
        cam.x = rect.width / 2
        cam.y = rect.height / 2
      }
      ensureRunning()
    }
    apply()
    const ro = new view.ResizeObserver(() => {
      if (!released && pendingResize === null) pendingResize = view.requestAnimationFrame(apply)
    })
    ro.observe(wrap)
    const cleanup = (): void => {
      if (released) return
      released = true
      ro.disconnect()
      if (pendingResize !== null) view.cancelAnimationFrame(pendingResize)
      pendingResize = null
    }
    const offOwner = owner.onDispose(cleanup)
    return () => { offOwner(); cleanup() }
  }, [owner, ensureRunning])

  React.useEffect(() => {
    const wrap = wrapRef.current
    const document = canvasRef.current?.ownerDocument
    if (!wrap || !document) return
    const Observer = document.defaultView?.IntersectionObserver
    const observer = Observer ? new Observer(records => {
      const record = records.find(record => record.target === wrap)
      if (record) intersectingRef.current = record.isIntersecting
      ensureRunning()
    }) : null
    intersectingRef.current = !observer
    observer?.observe(wrap)
    const update = (): void => ensureRunning()
    document.addEventListener('visibilitychange', update)
    // The host restyles this document when the appearance changes; colours are
    // read at draw time, so repaint instead of keeping the old theme's pixels.
    const ThemeObserver = document.defaultView?.MutationObserver
    const theme = ThemeObserver ? new ThemeObserver(update) : null
    theme?.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    let released = false
    const cleanup = (): void => {
      if (released) return
      released = true
      observer?.disconnect()
      theme?.disconnect()
      document.removeEventListener('visibilitychange', update)
      stopRunning()
    }
    const offOwner = owner.onDispose(cleanup)
    ensureRunning()
    return () => { offOwner(); cleanup() }
  }, [owner, ensureRunning, stopRunning])

  const nodeAt = (clientX: number, clientY: number): GraphNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const cam = cameraRef.current
    const cfg = configRef.current
    let best: GraphNode | null = null
    let bestD = Infinity
    for (const n of visibleGraph().nodes) {
      const sx = n.x * cam.scale + cam.x
      const sy = n.y * cam.scale + cam.y
      const r = radiusOf(n, cfg.display.nodeSize) * clamp(cam.scale, 0.15, 2.2) + 6
      const d = (sx - px) ** 2 + (sy - py) ** 2
      if (d <= r * r && d < bestD) {
        best = n
        bestD = d
      }
    }
    return best
  }

  const setHover = (node: GraphNode | null): void => {
    const id = node ? node.id : null
    if (id !== hoverRef.current.id) {
      hoverRef.current.id = id
      if (id) {
        const neighbors = new Set<string>()
        for (const e of visibleGraph().edges) {
          if (e.source === id) neighbors.add(e.target)
          if (e.target === id) neighbors.add(e.source)
        }
        neighborsRef.current = neighbors
      }
      const canvas = canvasRef.current
      if (canvas) canvas.style.cursor = id ? 'pointer' : 'grab'
      ensureRunning()
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    camAnimRef.current = null
    zoomTargetRef.current = null
    pendingFitRef.current = false
    const hit = nodeAt(e.clientX, e.clientY)
    dragRef.current = {
      id: hit ? hit.id : null,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      alt: e.altKey
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    const cam = cameraRef.current
    if (drag) {
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
      drag.startX = e.clientX
      drag.startY = e.clientY
      if (drag.id) {
        const node = dataRef.current.nodes.find((n) => n.id === drag.id)
        if (node) {
          node.x += dx / cam.scale
          node.y += dy / cam.scale
          node.vx = 0
          node.vy = 0
          posRef.current.set(node.id, { x: node.x, y: node.y, vx: 0, vy: 0 })
        }
        // Gentle reheat while dragging — a full kick makes the layout boil.
        alphaRef.current = Math.max(alphaRef.current, 0.3)
        ensureRunning()
      } else {
        cam.x += dx
        cam.y += dy
        draw()
      }
      return
    }
    setHover(nodeAt(e.clientX, e.clientY))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || !drag.id) return
    const node = dataRef.current.nodes.find((n) => n.id === drag.id)
    if (!node) return
    if (!drag.moved) {
      openNode(node, owner.api.ui.hasModKey(e))
      return
    }
    // A dropped pinned node stays pinned at the new spot; Alt-drag pins.
    if (node.pinned || drag.alt) {
      node.pinned = true
      onTogglePinRef.current?.(node.id, { x: node.x, y: node.y })
      draw()
    }
  }

  const onPointerLeave = (): void => {
    setHover(null)
  }

  // Right-click: node actions (open / pin / copy path) or canvas actions.
  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    e.preventDefault()
    const node = nodeAt(e.clientX, e.clientY)
    const position = { x: e.clientX, y: e.clientY }
    if (node) {
      void owner.api.ui
        .openMenu(
          [
            { id: 'open', label: uiText('auto.cf9b77061f7b'), enabled: Boolean(node.path || node.documentRef) },
            ...(onCenterRef.current
              ? [{ id: 'center', label: uiText('auto.331bfe68a6ba'), enabled: node.id !== centerId }]
              : []),
            { id: 'pin', label: node.pinned ? uiText('auto.2eba6a03b89a') : uiText('auto.e8b68c5b53e6') },
            { id: 'copy', label: uiText('auto.9804556fd4b8'), enabled: Boolean(node.path || node.documentRef) }
          ],
          position
        )
        .then((choice) => {
          try { owner.assertCurrent() } catch { return }
          if (choice === 'open') openNode(node)
          if (choice === 'center') onCenterRef.current?.(node.id)
          if (choice === 'copy' && (node.path || node.documentRef)) void navigator.clipboard.writeText(node.documentRef ? `[[${node.id}|${node.label}]]` : node.path)
          if (choice === 'pin') {
            const next = !node.pinned
            node.pinned = next
            onTogglePinRef.current?.(node.id, next ? { x: node.x, y: node.y } : null)
            if (next) ensureRunning()
            else kick()
          }
        }).catch(() => {})
      return
    }
    const anyPinned = dataRef.current.nodes.some((n) => n.pinned)
    void owner.api.ui
      .openMenu(
        [
          { id: 'fit', label: uiText('auto.be866a8e8673') },
          { id: 'unpin-all', label: uiText('auto.f4289396ca57'), enabled: anyPinned }
        ],
        position
      )
      .then((choice) => {
        try { owner.assertCurrent() } catch { return }
        if (choice === 'fit') {
          pendingFitRef.current = false
          fitView(true)
          ensureRunning()
        }
        if (choice === 'unpin-all') {
          for (const n of dataRef.current.nodes) n.pinned = false
          onUnpinAllRef.current?.()
          kick()
        }
      }).catch(() => {})
  }

  // Wheel zoom must be a native non-passive listener — React delegates wheel
  // passively at the root, so its synthetic handler can't preventDefault.
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      camAnimRef.current = null
      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      pendingFitRef.current = false
      const cam = zoomTargetRef.current ?? cameraRef.current
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1
      const delta = clamp(e.deltaY * unit, -500, 500)
      const next = clamp(cam.scale * Math.exp(-delta * 0.0015), MIN_SCALE, MAX_SCALE)
      zoomTargetRef.current = {
        x: px - ((px - cam.x) * next) / cam.scale,
        y: py - ((py - cam.y) * next) / cam.scale,
        scale: next
      }
      ensureRunning()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [ensureRunning])

  const h = React.createElement
  return h(
    'div',
    { ref: wrapRef, className: 'graphview-canvas-wrap' },
    openError ? h('p', { role: 'alert', className: 'graphview-open-error' }, openError) : null,
    h('canvas', {
      ref: canvasRef,
      className: 'graphview-canvas',
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerLeave,
      onContextMenu,
      style: { touchAction: 'none', cursor: 'grab', display: 'block' }
    }),
    data.nodes.length === 0 ? h(EmptyHint, { owner, text: emptyText }) : null
  )
}
