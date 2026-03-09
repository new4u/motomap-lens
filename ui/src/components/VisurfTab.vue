<script setup lang="ts">
/**
 * VisurfTab.vue - Context Lens 的 Visurf 风格 Map 可视化
 *
 * 颜色 scheme 来自 本地调试+openclaw.md:
 * - System Prompt → 蓝 (中心节点)
 * - Tool Definitions → 绿 (工具群节点)
 * - User Messages → 黄 (用户对话节点)
 * - Tool Results → 紫 (工具返回节点)
 * - Assistant Response → 白/灰 (AI 回复节点)
 * - PII/Security Alert → 红 (告警节点)
 *
 * 边关系:
 * - System Prompt → User Message (指导)
 * - User Message → Tool Call (触发)
 * - Tool Result → Assistant Response (依赖)
 * - 任何节点 → PII 节点 (包含)
 */
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useSessionStore } from '@/stores/session'
import { decomposeNode as apiDecomposeNode, type DecomposeResult } from '@/api'
const store = useSessionStore()
const containerRef = ref<HTMLDivElement | null>(null)

// ═══ Decompose 状态 ═══
const decomposeLoading = ref(false)
const decomposeResult = ref<DecomposeResult | null>(null)
const decomposeError = ref('')

// ═══ 类型定义 ═══
interface GraphNode {
  id: string
  type: 'system' | 'tools' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'thinking' | 'alert' | 'turn'
  label: string
  tokens: number
  cost: number
  turnIndex: number
  category: string
  x: number
  y: number
  vx: number
  vy: number
  fx: number | null
  fy: number | null
  color: string
  radius: number
  entryId?: number
  alertCount?: number
}

interface GraphEdge {
  id: string
  source: string
  target: string
  type: 'sequence' | 'dependency' | 'trigger' | 'alert'
  weight: number
  color: string
}

type LayoutMode = 'galaxy' | 'timeline' | 'force'

const nodes = ref<GraphNode[]>([])
const edges = ref<GraphEdge[]>([])
const hoveredNode = ref<GraphNode | null>(null)
const selectedNode = ref<GraphNode | null>(null)
const layoutMode = ref<LayoutMode>('galaxy')

// Tooltip 位置 (鼠标坐标)
const tooltipX = ref(0)
const tooltipY = ref(0)

const width = ref(800)
const height = ref(600)
let animationFrame: number | null = null
let tickCount = 0
let simRunning = false

// ═══ 手动刷新控制 ═══
const lastEntryCount = ref(0)      // 上次渲染时的 entry 数量
const pendingEntryCount = ref(0)   // 等待刷新的 entry 数量
const hasPendingUpdate = ref(false) // 是否有待刷新数据
const isFirstLoad = ref(true)      // 首次加载自动渲染

// ═══ 筛选 & 排序 ═══
const hiddenTypes = ref<Set<string>>(new Set()) // 隐藏的节点类型
const turnOrder = ref<'asc' | 'desc'>('asc')    // Turn 排序方向

function toggleType(type: string) {
  const s = new Set(hiddenTypes.value)
  if (s.has(type)) s.delete(type)
  else s.add(type)
  hiddenTypes.value = s
}

function toggleTurnOrder() {
  turnOrder.value = turnOrder.value === 'asc' ? 'desc' : 'asc'
}

// ═══ 颜色 scheme (来自 本地调试+openclaw.md) ═══
const nodeColors: Record<string, string> = {
  system: '#0ea5e9',       // 蓝 - System Prompt
  tools: '#10b981',        // 绿 - Tool Definitions
  user: '#f59e0b',         // 黄 - User Messages
  assistant: '#b4b4b4',    // 白/灰 - Assistant Response
  tool_call: '#ef4444',    // 红橙 - Tool Calls
  tool_result: '#a78bfa',  // 紫 - Tool Results
  thinking: '#ec4899',     // 粉 - Thinking
  alert: '#ef4444',        // 红 - PII/Security Alert
  turn: '#10b981',         // 绿 - Turn 标记
}

const nodeLabels: Record<string, string> = {
  system: 'System',
  tools: 'Tools',
  user: 'User',
  assistant: 'Assistant',
  tool_call: 'Tool Call',
  tool_result: 'Tool Result',
  thinking: 'Thinking',
  alert: 'Alert',
  turn: 'Turn',
}

// Category → node type 映射
function categoryToType(cat: string): GraphNode['type'] {
  switch (cat) {
    case 'system_prompt': return 'system'
    case 'system_injections': return 'system'
    case 'tool_definitions': return 'tools'
    case 'user_text': return 'user'
    case 'assistant_text': return 'assistant'
    case 'tool_calls': return 'tool_call'
    case 'tool_results': return 'tool_result'
    case 'thinking': return 'thinking'
    case 'images': return 'tool_result'
    case 'cache_markers': return 'system'
    default: return 'assistant'
  }
}

function tokenRadius(tokens: number): number {
  return Math.max(5, Math.min(35, Math.sqrt(tokens) * 0.45))
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return tokens.toString()
}

// ═══ 构建图谱 ═══
function buildGraph() {
  const session = store.selectedSession
  if (!session || session.entries.length === 0) {
    nodes.value = []
    edges.value = []
    return
  }

  const newNodes: GraphNode[] = []
  const newEdges: GraphEdge[] = []
  // 确保中心点合理 (容器可能还没测量到尺寸)
  const cx = (width.value || 800) / 2
  const cy = (height.value || 600) / 2
  let prevNodeId: string | null = null
  let nodeIndex = 0

  // 倒序遍历 entries (context-lens entries 是倒序的)
  const entries = [...session.entries].reverse()

  entries.forEach((entry, entryIndex) => {
    const turnIndex = entryIndex + 1

    // 从 composition 创建节点
    if (entry.composition && entry.composition.length > 0) {
      for (const comp of entry.composition) {
        if (comp.tokens < 10) continue // 跳过极小的
        const type = categoryToType(comp.category)
        const id = `n-${entry.id}-${comp.category}-${nodeIndex}`
        const angle = (2 * Math.PI * nodeIndex) / 30 + Math.random() * 0.3
        const dist = 100 + Math.random() * 200
        const r = tokenRadius(comp.tokens)

        newNodes.push({
          id,
          type,
          label: comp.category.replace(/_/g, ' '),
          tokens: comp.tokens,
          cost: (entry.costUsd || 0) * (comp.pct / 100),
          turnIndex,
          category: comp.category,
          x: cx + Math.cos(angle) * dist,
          y: cy + Math.sin(angle) * dist,
          vx: 0, vy: 0,
          fx: null, fy: null,
          color: nodeColors[type],
          radius: r,
          entryId: entry.id,
        })

        // 时序边
        if (prevNodeId) {
          newEdges.push({
            id: `e-seq-${prevNodeId}-${id}`,
            source: prevNodeId,
            target: id,
            type: 'sequence',
            weight: 1,
            color: 'rgba(100, 100, 100, 0.3)',
          })
        }

        // 依赖边: tool_calls → tool_results
        if (comp.category === 'tool_results' && prevNodeId) {
          const prevNode = newNodes.find(n => n.id === prevNodeId && n.category === 'tool_calls')
          if (prevNode) {
            newEdges.push({
              id: `e-dep-${prevNodeId}-${id}`,
              source: prevNodeId,
              target: id,
              type: 'dependency',
              weight: 2,
              color: 'rgba(167, 139, 250, 0.5)',
            })
          }
        }

        prevNodeId = id
        nodeIndex++
      }
    }

    // Security Alert 节点 (PII → 红色)
    if (entry.securityAlerts && entry.securityAlerts.length > 0) {
      const alertId = `alert-${entry.id}`
      newNodes.push({
        id: alertId,
        type: 'alert',
        label: `${entry.securityAlerts.length} alerts`,
        tokens: 0,
        cost: 0,
        turnIndex,
        category: 'security',
        x: cx + Math.random() * 100 - 50,
        y: cy + Math.random() * 100 - 50,
        vx: 0, vy: 0,
        fx: null, fy: null,
        color: nodeColors.alert,
        radius: 6 + entry.securityAlerts.length * 2,
        entryId: entry.id,
        alertCount: entry.securityAlerts.length,
      })

      // 关联边到最近的节点
      if (prevNodeId) {
        newEdges.push({
          id: `e-alert-${prevNodeId}-${alertId}`,
          source: prevNodeId,
          target: alertId,
          type: 'alert',
          weight: 1,
          color: 'rgba(239, 68, 68, 0.4)',
        })
      }
    }
  })

  nodes.value = newNodes
  edges.value = newEdges
  startSim()
}

// ═══ 力模拟 ═══
const MAX_TICKS = 250 // 最多跑 250 帧后完全停止

function startSim() {
  if (simRunning) {
    // 拖拽时重置 tick 计数器，避免模拟过早停止
    tickCount = Math.min(tickCount, 100)
    return
  }
  tickCount = 0
  simRunning = true
  animationFrame = requestAnimationFrame(tick)
}

function stopSim() {
  simRunning = false
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
    animationFrame = null
  }
}

function tick() {
  if (!simRunning) return
  const N = nodes.value
  const E = edges.value
  if (N.length === 0) { stopSim(); return }

  tickCount++
  if (tickCount > MAX_TICKS) { stopSim(); return }

  // alpha 从 0.5 快速衰减到 0
  const alpha = 0.5 * Math.exp(-tickCount / 50)
  if (alpha < 0.003) { stopSim(); return }

  const W = width.value || 800
  const H = height.value || 600
  const cx = W / 2
  const cy = H / 2

  // Turn 分组 (与 turnOrder 同步)
  const turnSet = new Set<number>()
  N.forEach(n => turnSet.add(n.turnIndex))
  let sortedTurns = [...turnSet].sort((a, b) => a - b)
  if (turnOrder.value === 'desc') sortedTurns.reverse()
  const turnMap = new Map<number, number>()
  sortedTurns.forEach((t, i) => turnMap.set(t, i))
  const totalTurns = turnMap.size

  // 邻接表 (每帧重建，但数据量小)
  const neighbors = new Map<string, string[]>()
  for (const e of E) {
    if (!neighbors.has(e.source)) neighbors.set(e.source, [])
    if (!neighbors.has(e.target)) neighbors.set(e.target, [])
    neighbors.get(e.source)!.push(e.target)
    neighbors.get(e.target)!.push(e.source)
  }

  // 节点 ID → 节点 快查
  const nodeById = new Map(N.map(n => [n.id, n]))

  for (const node of N) {
    if (node.fx !== null) { node.x = node.fx; continue }
    if (node.fy !== null) { node.y = node.fy; continue }

    let ffx = 0, ffy = 0

    // 排斥力
    for (const other of N) {
      if (node.id === other.id) continue
      const dx = node.x - other.x
      const dy = node.y - other.y
      const dist2 = dx * dx + dy * dy + 1
      const dist = Math.sqrt(dist2)
      // Timeline 模式排斥力更强，分散更开
      const repulsion = layoutMode.value === 'timeline' ? 1200 : layoutMode.value === 'galaxy' ? 400 : 600
      const force = repulsion / dist2
      ffx += (dx / dist) * force
      ffy += (dy / dist) * force

      // 碰撞 (加大间距)
      const gap = layoutMode.value === 'timeline' ? 12 : 6
      const minDist = node.radius + other.radius + gap
      if (dist < minDist) {
        const push = (minDist - dist) * 0.5
        ffx += (dx / dist) * push
        ffy += (dy / dist) * push
      }
    }

    // 吸引力 (边连接)
    const adj = neighbors.get(node.id)
    if (adj) {
      for (const otherId of adj) {
        const other = nodeById.get(otherId)
        if (!other) continue
        const dx = other.x - node.x
        const dy = other.y - node.y
        const attraction = layoutMode.value === 'galaxy' ? 0.01 : 0.02
        ffx += dx * attraction
        ffy += dy * attraction
      }
    }

    // 布局力
    if (layoutMode.value === 'galaxy') {
      ffx += (cx - node.x) * 0.003
      ffy += (cy - node.y) * 0.003
    } else if (layoutMode.value === 'timeline') {
      // Timeline: Y 轴强制按 Turn，X 轴居中分散
      const turnSpacing = Math.max(55, (H - 60) / (totalTurns + 1))
      const gi = turnMap.get(node.turnIndex) || 0
      const targetY = 40 + gi * turnSpacing

      // 强力 Y 轴吸引 (直接插值，不是力)
      node.y += (targetY - node.y) * 0.3
      ffy *= 0.05 // 大幅削弱 Y 方向的其他力

      // X 轴: 弱居中力 (允许水平分散)
      ffx += (cx - node.x) * 0.005
    } else {
      ffx += (cx - node.x) * 0.004
      ffy += (cy - node.y) * 0.004
    }

    // 应用
    node.vx = (node.vx + ffx * alpha) * 0.8
    node.vy = (node.vy + ffy * alpha) * 0.8
    node.x += node.vx
    node.y += node.vy

    // 边界
    const pad = node.radius + 4
    node.x = Math.max(pad, Math.min(W - pad, node.x))
    node.y = Math.max(pad, Math.min(H - pad, node.y))
  }

  animationFrame = requestAnimationFrame(tick)
}

// ═══ 尺寸 ═══
function updateSize() {
  if (containerRef.value) {
    width.value = containerRef.value.clientWidth
    height.value = containerRef.value.clientHeight
  }
}

// ═══ 拖拽 ═══
let dragNode: GraphNode | null = null
let dragStartX = 0
let dragStartY = 0
let isDragging = false

function onDragStart(node: GraphNode, event: MouseEvent) {
  event.preventDefault()
  dragNode = node
  dragStartX = event.clientX
  dragStartY = event.clientY
  isDragging = false
  // 固定该节点位置
  node.fx = node.x
  node.fy = node.y
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
  // 拖拽时恢复模拟让其他节点反应
  startSim()
}

function onDragMove(event: MouseEvent) {
  if (!dragNode) return
  const dx = event.clientX - dragStartX
  const dy = event.clientY - dragStartY
  if (!isDragging && Math.abs(dx) + Math.abs(dy) > 3) isDragging = true
  if (!isDragging) return

  const rect = containerRef.value?.getBoundingClientRect()
  if (rect) {
    dragNode.fx = event.clientX - rect.left
    dragNode.fy = event.clientY - rect.top
    dragNode.x = dragNode.fx
    dragNode.y = dragNode.fy
    // 更新 tooltip 位置
    tooltipX.value = event.clientX - rect.left + 16
    tooltipY.value = event.clientY - rect.top - 10
  }
}

function onDragEnd() {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  if (dragNode) {
    // 释放固定 (节点会被力模拟自然移动)
    dragNode.fx = null
    dragNode.fy = null
    if (!isDragging) {
      // 没有实际拖动 = 点击
      onNodeClick(dragNode)
    }
  }
  dragNode = null
  isDragging = false
}

// ═══ 交互 ═══
function onNodeHover(node: GraphNode | null, event?: MouseEvent) {
  hoveredNode.value = node
  if (event && node) {
    const rect = containerRef.value?.getBoundingClientRect()
    if (rect) {
      tooltipX.value = event.clientX - rect.left + 16
      tooltipY.value = event.clientY - rect.top - 10
    }
  }
}

function onMouseMove(event: MouseEvent) {
  if (hoveredNode.value && !isDragging) {
    const rect = containerRef.value?.getBoundingClientRect()
    if (rect) {
      tooltipX.value = event.clientX - rect.left + 16
      tooltipY.value = event.clientY - rect.top - 10
    }
  }
}

function onNodeClick(node: GraphNode) {
  selectedNode.value = selectedNode.value?.id === node.id ? null : node
  // Turn 节点跳转到 Messages tab
  if (node.entryId) {
    store.pinEntry(node.entryId)
  }
}

function switchLayout(mode: LayoutMode) {
  layoutMode.value = mode
  stopSim()
  // Timeline 切换时重置节点 Y 坐标到合理初始位置
  if (mode === 'timeline') {
    const H = height.value || 600
    const turnSet = new Set<number>()
    nodes.value.forEach(n => turnSet.add(n.turnIndex))
    let sortedTurns = [...turnSet].sort((a, b) => a - b)
    if (turnOrder.value === 'desc') sortedTurns.reverse()
    const turnMap = new Map<number, number>()
    sortedTurns.forEach((t, i) => turnMap.set(t, i))
    const totalTurns = turnMap.size
    const spacing = Math.max(55, (H - 60) / (totalTurns + 1))
    const cx = (width.value || 800) / 2
    const W = width.value || 800
    nodes.value.forEach(n => {
      const gi = turnMap.get(n.turnIndex) || 0
      n.y = 40 + gi * spacing + (Math.random() - 0.5) * 20
      // 利用整个宽度分散 (留 10% 边距)
      n.x = W * 0.1 + Math.random() * W * 0.8
      n.vx = 0
      n.vy = 0
    })
  }
  startSim()
}

// ═══ 计算属性 ═══
interface EdgePath extends GraphEdge {
  x1: number; y1: number; x2: number; y2: number
}

const edgePaths = computed<EdgePath[]>(() => {
  const result: EdgePath[] = []
  const nodeMap = new Map(visibleNodes.value.map(n => [n.id, n]))
  for (const edge of visibleEdges.value) {
    const s = nodeMap.get(edge.source)
    const t = nodeMap.get(edge.target)
    if (s && t) {
      result.push({ ...edge, x1: s.x, y1: s.y, x2: t.x, y2: t.y })
    }
  }
  return result
})

// 边是否与 hovered 节点相关
function isEdgeHighlighted(edge: GraphEdge): boolean {
  if (!hoveredNode.value) return false
  return edge.source === hoveredNode.value.id || edge.target === hoveredNode.value.id
}

function edgeOpacity(edge: GraphEdge): number {
  if (!hoveredNode.value) return 0.4
  return isEdgeHighlighted(edge) ? 0.9 : 0.08
}

function edgeStrokeWidth(edge: GraphEdge): number {
  if (!hoveredNode.value) return Math.max(1, edge.weight)
  return isEdgeHighlighted(edge) ? 3 : 1
}

// ═══ 可见节点/边 (受筛选影响) ═══
const visibleNodes = computed(() => {
  return nodes.value.filter(n => !hiddenTypes.value.has(n.type))
})

const visibleEdges = computed(() => {
  const visibleIds = new Set(visibleNodes.value.map(n => n.id))
  return edges.value.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target))
})

// Token 分布统计 (基于全部节点，不受筛选影响)
const stats = computed(() => {
  const total = nodes.value.reduce((s, n) => s + n.tokens, 0)
  const byType: Record<string, number> = {}
  nodes.value.forEach(n => {
    byType[n.type] = (byType[n.type] || 0) + n.tokens
  })
  const turns = new Set(nodes.value.map(n => n.turnIndex)).size
  return { total, byType, turns, nodeCount: nodes.value.length }
})

// Token 分布条 (按大小排序)
const tokenBars = computed(() => {
  const total = stats.value.total || 1
  return Object.entries(stats.value.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, tokens]) => ({
      type,
      tokens,
      pct: (tokens / total) * 100,
      color: nodeColors[type] || '#666',
      label: nodeLabels[type] || type,
    }))
})

// Timeline Turn 标签 (支持排序)
const turnLabels = computed(() => {
  if (layoutMode.value !== 'timeline') return []
  // 收集所有出现的 turn 编号
  const turnSet = new Set<number>()
  visibleNodes.value.forEach(n => turnSet.add(n.turnIndex))
  let turns = [...turnSet].sort((a, b) => a - b)
  if (turnOrder.value === 'desc') turns.reverse()
  const totalTurns = turns.length
  const spacing = Math.max(60, (height.value - 80) / (totalTurns + 1))
  return turns.map((turn, gi) => ({ turn, y: 50 + gi * spacing }))
})

// ═══ Decompose ═══
async function handleDecompose() {
  const node = selectedNode.value
  if (!node || !node.entryId) return

  decomposeLoading.value = true
  decomposeError.value = ''
  decomposeResult.value = null

  try {
    const result = await apiDecomposeNode(node.entryId, node.category)
    result.sourceNode = {
      label: node.label,
      category: node.category,
      tokens: node.tokens,
    }
    decomposeResult.value = result
  } catch (e) {
    decomposeError.value = e instanceof Error ? e.message : String(e)
  } finally {
    decomposeLoading.value = false
  }
}

function closeDecompose() {
  decomposeResult.value = null
  decomposeError.value = ''
}

// Decompose 子图布局计算 (径向)
const decomposeLayout = computed(() => {
  const dr = decomposeResult.value
  if (!dr || dr.nodes.length === 0) return { nodes: [], edges: [] }

  const cxD = 300
  const cyD = 250
  const baseRadius = 150
  const count = dr.nodes.length

  const laidOutNodes = dr.nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2
    const r = baseRadius * (0.7 + n.importance * 0.3)
    const size = Math.max(16, Math.min(40, Math.sqrt(n.tokens_estimate) * 0.6))
    return {
      ...n,
      cx: cxD + Math.cos(angle) * r,
      cy: cyD + Math.sin(angle) * r,
      size,
    }
  })

  const nodeMap = new Map(laidOutNodes.map(n => [n.id, n]))
  const laidOutEdges = dr.edges
    .filter(e => nodeMap.has(e.source) && nodeMap.has(e.target))
    .map(e => ({
      ...e,
      x1: nodeMap.get(e.source)!.cx,
      y1: nodeMap.get(e.source)!.cy,
      x2: nodeMap.get(e.target)!.cx,
      y2: nodeMap.get(e.target)!.cy,
    }))

  return { nodes: laidOutNodes, edges: laidOutEdges, center: { cx: cxD, cy: cyD } }
})

const decomposeTypeColors: Record<string, string> = {
  instruction: '#0ea5e9',
  data: '#10b981',
  code: '#a78bfa',
  query: '#f59e0b',
  response: '#b4b4b4',
  metadata: '#6b7280',
  tool: '#ec4899',
  reasoning: '#f97316',
}

// ═══ 手动刷新 ═══
function applyUpdate() {
  hasPendingUpdate.value = false
  buildGraph()
  lastEntryCount.value = store.selectedSession?.entries.length || 0
}

// ═══ 生命周期 ═══
// Session 切换时自动渲染
watch(() => store.selectedSession?.id, () => {
  isFirstLoad.value = true
  hasPendingUpdate.value = false
  lastEntryCount.value = 0
  buildGraph()
  lastEntryCount.value = store.selectedSession?.entries.length || 0
}, { immediate: true })

// Turn 排序变化时，如果是 timeline 模式则重排
watch(turnOrder, () => {
  if (layoutMode.value === 'timeline') {
    switchLayout('timeline')
  }
})

// Entry 数量变化时，提示而非自动刷新
watch(() => store.selectedSession?.entries.length, (newLen) => {
  if (!newLen) return
  // 首次加载时自动渲染
  if (isFirstLoad.value) {
    isFirstLoad.value = false
    lastEntryCount.value = newLen
    return
  }
  // 有新数据进来
  if (newLen !== lastEntryCount.value) {
    pendingEntryCount.value = newLen
    hasPendingUpdate.value = true
  }
})

onMounted(() => {
  updateSize()
  window.addEventListener('resize', updateSize)
  nextTick(() => {
    updateSize()
    buildGraph()
  })
})

onUnmounted(() => {
  window.removeEventListener('resize', updateSize)
  stopSim()
})
</script>

<template>
  <div class="visurf-tab" ref="containerRef" @mousemove="onMouseMove">
    <!-- 顶部工具栏 -->
    <div class="visurf-header">
      <div class="header-left">
        <h3>Session Map</h3>
        <div class="layout-btns">
          <button
            v-for="mode in (['galaxy', 'timeline', 'force'] as LayoutMode[])"
            :key="mode"
            class="layout-btn"
            :class="{ active: layoutMode === mode }"
            @click="switchLayout(mode)"
          >
            {{ mode }}
          </button>
        </div>
      </div>
      <div class="header-stats">
        <span class="stat">
          <strong>{{ stats.total.toLocaleString() }}</strong> tokens
        </span>
        <span class="stat">
          <strong>{{ stats.nodeCount }}</strong> nodes
        </span>
        <span class="stat">
          <strong>{{ stats.turns }}</strong> turns
        </span>
      </div>
    </div>

    <!-- 图例 (可点击筛选) -->
    <div class="visurf-legend">
      <span
        v-for="(color, type) in nodeColors"
        :key="type"
        class="legend-item"
        :class="{ hidden: hiddenTypes.has(type) }"
        @click="toggleType(type as string)"
        :title="hiddenTypes.has(type) ? `Show ${nodeLabels[type]}` : `Hide ${nodeLabels[type]}`"
      >
        <span class="dot" :style="{
          background: hiddenTypes.has(type) ? 'transparent' : color,
          boxShadow: hiddenTypes.has(type) ? 'none' : `0 0 6px ${color}60`,
          borderColor: color
        }"></span>
        {{ nodeLabels[type] || type }}
        <span v-if="stats.byType[type]" class="legend-tokens">
          ({{ formatTokens(stats.byType[type]) }})
        </span>
      </span>
      <!-- Turn 排序按钮 -->
      <span class="legend-divider">|</span>
      <span class="sort-btn" @click="toggleTurnOrder" title="Toggle turn order">
        Turns {{ turnOrder === 'asc' ? '1→N' : 'N→1' }}
      </span>
    </div>

    <!-- 新数据提示条 -->
    <div v-if="hasPendingUpdate" class="update-bar">
      <span class="update-text">
        New data: {{ pendingEntryCount }} entries
        <span class="update-diff">(+{{ pendingEntryCount - lastEntryCount }})</span>
      </span>
      <button class="update-btn" @click="applyUpdate">Refresh</button>
      <button class="update-dismiss" @click="hasPendingUpdate = false">×</button>
    </div>

    <!-- SVG 画布 -->
    <svg ref="svgRef" :width="width" :height="height" class="visurf-svg">
      <!-- 发光滤镜 -->
      <defs>
        <filter v-for="(color, type) in nodeColors" :key="type" :id="`glow-${type}`"
          x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feFlood :flood-color="color" flood-opacity="0.4" result="color" />
          <feComposite in="color" in2="blur" operator="in" result="shadow" />
          <feMerge>
            <feMergeNode in="shadow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <!-- hover 高亮滤镜 -->
        <filter id="glow-hover" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feFlood flood-color="#ffffff" flood-opacity="0.5" result="color" />
          <feComposite in="color" in2="blur" operator="in" result="shadow" />
          <feMerge>
            <feMergeNode in="shadow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <!-- Timeline Turn 标签 -->
      <g v-if="layoutMode === 'timeline'">
        <g v-for="tl in turnLabels" :key="tl.turn">
          <text :x="16" :y="tl.y + 4" class="turn-label">Turn {{ tl.turn }}</text>
          <line :x1="70" :x2="width - 16" :y1="tl.y" :y2="tl.y"
            stroke="var(--border-dim)" stroke-width="1" stroke-dasharray="3,8" opacity="0.4" />
        </g>
      </g>

      <!-- 边 -->
      <g class="edges">
        <line
          v-for="edge in edgePaths"
          :key="edge.id"
          :x1="edge.x1" :y1="edge.y1"
          :x2="edge.x2" :y2="edge.y2"
          :stroke="isEdgeHighlighted(edge) ? nodeColors[visibleNodes.find(n => n.id === edge.source)?.type || 'assistant'] : edge.color"
          :stroke-width="edgeStrokeWidth(edge)"
          :stroke-dasharray="edge.type === 'dependency' ? '5,3' : edge.type === 'alert' ? '2,4' : 'none'"
          :opacity="edgeOpacity(edge)"
          class="edge-line"
        />
      </g>

      <!-- 节点 -->
      <g class="nodes">
        <g
          v-for="node in visibleNodes"
          :key="node.id"
          class="node"
          :class="{
            hovered: hoveredNode?.id === node.id,
            selected: selectedNode?.id === node.id,
            dimmed: hoveredNode && hoveredNode.id !== node.id,
          }"
          :transform="`translate(${node.x}, ${node.y})`"
          @mouseenter="onNodeHover(node, $event)"
          @mouseleave="onNodeHover(null)"
          @mousedown="onDragStart(node, $event)"
        >
          <!-- 圆形 + 发光 -->
          <circle
            :r="node.radius"
            :fill="node.color"
            :stroke="selectedNode?.id === node.id ? '#fff' : '#1a1a1a'"
            stroke-width="2"
            :filter="hoveredNode?.id === node.id ? 'url(#glow-hover)' : `url(#glow-${node.type})`"
          />
          <!-- Token 数字 (大节点才显示) -->
          <text
            v-if="node.radius > 10"
            y="4"
            text-anchor="middle"
            class="node-token"
          >
            {{ formatTokens(node.tokens) }}
          </text>
          <!-- 标签 (中等节点) -->
          <text
            v-if="node.radius > 7"
            :y="node.radius + 13"
            text-anchor="middle"
            class="node-label"
          >
            {{ node.label.length > 12 ? node.label.slice(0, 10) + '..' : node.label }}
          </text>
        </g>
      </g>
    </svg>

    <!-- Tooltip (鼠标跟随) -->
    <div
      v-if="hoveredNode"
      class="tooltip"
      :style="{ left: `${tooltipX}px`, top: `${tooltipY}px` }"
    >
      <div class="tooltip-title" :style="{ color: hoveredNode.color }">
        {{ hoveredNode.label }}
      </div>
      <div class="tooltip-type">{{ nodeLabels[hoveredNode.type] || hoveredNode.type }}</div>
      <div class="tooltip-stat">
        {{ hoveredNode.tokens.toLocaleString() }} tokens
      </div>
      <div v-if="hoveredNode.cost > 0" class="tooltip-stat">
        ${{ hoveredNode.cost.toFixed(4) }}
      </div>
      <div class="tooltip-turn">Turn {{ hoveredNode.turnIndex }}</div>
      <div v-if="hoveredNode.alertCount" class="tooltip-alert">
        {{ hoveredNode.alertCount }} security alerts
      </div>
    </div>

    <!-- 选中节点详情 -->
    <div v-if="selectedNode" class="detail-panel">
      <div class="detail-header">
        <span class="detail-type" :style="{ background: selectedNode.color }">
          {{ nodeLabels[selectedNode.type] || selectedNode.type }}
        </span>
        <button class="detail-close" @click="selectedNode = null">×</button>
      </div>
      <div class="detail-label">{{ selectedNode.label }}</div>
      <div class="detail-row">
        <span class="detail-key">Tokens</span>
        <span class="detail-value detail-tokens">{{ selectedNode.tokens.toLocaleString() }}</span>
      </div>
      <div v-if="selectedNode.cost > 0" class="detail-row">
        <span class="detail-key">Cost</span>
        <span class="detail-value">${{ selectedNode.cost.toFixed(4) }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Turn</span>
        <span class="detail-value">{{ selectedNode.turnIndex }}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Category</span>
        <span class="detail-badge" :style="{ background: selectedNode.color }">
          {{ selectedNode.category }}
        </span>
      </div>
      <div class="detail-actions">
        <button v-if="selectedNode.entryId" class="detail-btn" @click="store.setInspectorTab('messages')">
          View in Messages
        </button>
        <button
          v-if="selectedNode.entryId"
          class="detail-btn detail-btn-decompose"
          :disabled="decomposeLoading"
          @click="handleDecompose"
        >
          {{ decomposeLoading ? 'Decomposing...' : 'Decompose' }}
        </button>
      </div>
    </div>

    <!-- Decompose 错误提示 -->
    <div v-if="decomposeError && !decomposeResult" class="decompose-error">
      <span>{{ decomposeError }}</span>
      <button @click="decomposeError = ''">×</button>
    </div>

    <!-- Decompose 覆盖层子图 -->
    <div v-if="decomposeResult" class="decompose-overlay" @click.self="closeDecompose">
      <div class="decompose-panel">
        <div class="decompose-header">
          <div class="decompose-title">
            <span class="decompose-badge" :style="{ background: selectedNode?.color || '#666' }">
              {{ decomposeResult.sourceNode.category }}
            </span>
            <span class="decompose-label">Decompose: {{ decomposeResult.sourceNode.label }}</span>
          </div>
          <button class="decompose-close" @click="closeDecompose">×</button>
        </div>

        <div class="decompose-summary">{{ decomposeResult.summary }}</div>

        <div class="decompose-body">
          <svg class="decompose-svg" viewBox="0 0 600 500">
            <!-- 子节点间的边 -->
            <line
              v-for="(edge, i) in decomposeLayout.edges"
              :key="'de-' + i"
              :x1="edge.x1" :y1="edge.y1"
              :x2="edge.x2" :y2="edge.y2"
              stroke="rgba(100,100,100,0.3)"
              stroke-width="1.5"
              stroke-dasharray="4,3"
            />

            <!-- 中心节点到子节点的连线 -->
            <line
              v-for="node in decomposeLayout.nodes"
              :key="'dc-' + node.id"
              :x1="decomposeLayout.center?.cx || 300"
              :y1="decomposeLayout.center?.cy || 250"
              :x2="node.cx" :y2="node.cy"
              stroke="rgba(150,150,150,0.25)"
              stroke-width="1"
            />

            <!-- 中心原始节点 -->
            <g v-if="decomposeLayout.center">
              <circle
                :cx="decomposeLayout.center.cx"
                :cy="decomposeLayout.center.cy"
                :r="30"
                :fill="selectedNode?.color || '#666'"
                stroke="#fff"
                stroke-width="2"
                opacity="0.9"
              />
              <text
                :x="decomposeLayout.center.cx"
                :y="decomposeLayout.center.cy + 4"
                text-anchor="middle"
                fill="#fff"
                font-size="10"
                font-weight="700"
              >
                {{ decomposeResult.sourceNode.label.length > 10
                    ? decomposeResult.sourceNode.label.slice(0, 8) + '..'
                    : decomposeResult.sourceNode.label }}
              </text>
            </g>

            <!-- 分解子节点 -->
            <g v-for="node in decomposeLayout.nodes" :key="'dn-' + node.id">
              <circle
                :cx="node.cx" :cy="node.cy"
                :r="node.size / 2"
                :fill="decomposeTypeColors[node.type] || '#6b7280'"
                :stroke="node.importance > 0.7 ? '#fff' : 'rgba(255,255,255,0.3)'"
                :stroke-width="node.importance > 0.7 ? 2 : 1"
                :opacity="0.5 + node.importance * 0.5"
              />
              <text
                :x="node.cx"
                :y="node.cy + 3"
                text-anchor="middle"
                fill="#fff"
                font-size="8"
                font-weight="600"
              >
                {{ node.tokens_estimate > 0 ? formatTokens(node.tokens_estimate) : '' }}
              </text>
              <text
                :x="node.cx"
                :y="node.cy + node.size / 2 + 12"
                text-anchor="middle"
                fill="var(--text-muted, #999)"
                font-size="9"
              >
                {{ node.label.length > 15 ? node.label.slice(0, 13) + '..' : node.label }}
              </text>
            </g>
          </svg>
        </div>

        <!-- 子节点列表 -->
        <div class="decompose-list">
          <div
            v-for="node in decomposeResult.nodes"
            :key="'dl-' + node.id"
            class="decompose-item"
          >
            <span class="decompose-item-dot" :style="{ background: decomposeTypeColors[node.type] || '#6b7280' }"></span>
            <span class="decompose-item-label">{{ node.label }}</span>
            <span class="decompose-item-type">{{ node.type }}</span>
            <span class="decompose-item-tokens">~{{ formatTokens(node.tokens_estimate) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Token 分布条 -->
    <div class="token-bar" v-if="stats.total > 0">
      <div
        v-for="bar in tokenBars"
        :key="bar.type"
        class="bar-segment"
        :style="{ width: `${bar.pct}%`, background: bar.color }"
        :title="`${bar.label}: ${bar.tokens.toLocaleString()} tokens (${bar.pct.toFixed(1)}%)`"
      >
        <span v-if="bar.pct > 8" class="bar-text">
          {{ bar.label }} {{ bar.pct.toFixed(0) }}%
        </span>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.visurf-tab {
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--bg-deep);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

// ─── 顶部工具栏 ───
.visurf-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-dim);
  background: var(--bg-deep);
  z-index: 10;
  flex-shrink: 0;

  h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.layout-btns {
  display: flex;
  gap: 2px;
}

.layout-btn {
  padding: 3px 10px;
  font-size: var(--text-xs);
  font-weight: 500;
  text-transform: capitalize;
  background: transparent;
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;

  &:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  &.active {
    background: var(--accent-blue-dim);
    border-color: var(--accent-blue);
    color: var(--accent-blue);
  }
}

.header-stats {
  display: flex;
  gap: 12px;
  font-size: var(--text-xs);
  color: var(--text-muted);

  strong {
    color: var(--text-primary);
    font-family: var(--font-mono);
  }
}

// ─── 图例 ───
.visurf-legend {
  display: flex;
  gap: 10px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-dim);
  font-size: 9px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 3px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 3px;
  transition: all 0.15s;
  user-select: none;

  &:hover {
    background: var(--bg-hover);
  }

  &.hidden {
    opacity: 0.35;
    text-decoration: line-through;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    border: 1.5px solid transparent;
    transition: all 0.15s;
  }
}

.legend-tokens {
  color: var(--text-ghost);
  font-family: var(--font-mono);
}

.legend-divider {
  color: var(--border-dim);
  margin: 0 2px;
}

.sort-btn {
  cursor: pointer;
  color: var(--accent-blue);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  user-select: none;
  transition: all 0.15s;

  &:hover {
    background: var(--accent-blue-dim);
  }
}

// ─── 新数据提示条 ───
.update-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 12px;
  background: rgba(14, 165, 233, 0.12);
  border-bottom: 1px solid rgba(14, 165, 233, 0.3);
  flex-shrink: 0;
  animation: slideDown 0.2s ease;
}

@keyframes slideDown {
  from { transform: translateY(-100%); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.update-text {
  font-size: var(--text-xs);
  color: var(--accent-blue);
  font-weight: 500;
  flex: 1;
}

.update-diff {
  color: #10b981;
  font-family: var(--font-mono);
  font-weight: 700;
}

.update-btn {
  padding: 2px 12px;
  font-size: var(--text-xs);
  font-weight: 600;
  background: var(--accent-blue);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s;

  &:hover {
    background: #0284c7;
  }
}

.update-dismiss {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;

  &:hover {
    color: var(--text-primary);
  }
}

// ─── SVG 画布 ───
.visurf-svg {
  flex: 1;
  min-height: 0;
}

.turn-label {
  font-size: 11px;
  fill: var(--text-ghost);
  font-weight: 600;
}

// ─── 边 ───
.edge-line {
  transition: opacity 0.15s, stroke-width 0.15s;
}

// ─── 节点 ───
.node {
  cursor: pointer;

  circle {
    transition: stroke 0.15s, stroke-width 0.15s;
  }

  &.hovered circle {
    stroke: #fff;
    stroke-width: 3;
  }

  &.selected circle {
    stroke: #fff;
    stroke-width: 3;
  }

  &.dimmed {
    opacity: 0.4;
  }

  &.dimmed.hovered {
    opacity: 1;
  }
}

.node-token {
  font-size: 9px;
  fill: #fff;
  font-weight: 700;
  pointer-events: none;
  font-family: var(--font-mono);
}

.node-label {
  font-size: 9px;
  fill: var(--text-muted);
  pointer-events: none;
}

// ─── Tooltip ───
.tooltip {
  position: absolute;
  background: var(--bg-raised);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-md);
  padding: 8px 12px;
  pointer-events: none;
  z-index: 20;
  box-shadow: var(--shadow-lg);
  min-width: 120px;
  max-width: 220px;
}

.tooltip-title {
  font-size: var(--text-sm);
  font-weight: 700;
  margin-bottom: 1px;
}

.tooltip-type {
  font-size: var(--text-xs);
  color: var(--text-muted);
  margin-bottom: 4px;
}

.tooltip-stat {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-weight: 600;
}

.tooltip-turn {
  font-size: 9px;
  color: var(--text-ghost);
  margin-top: 2px;
}

.tooltip-alert {
  font-size: var(--text-xs);
  color: var(--accent-red);
  font-weight: 600;
  margin-top: 2px;
}

// ─── 选中详情 ───
.detail-panel {
  position: absolute;
  bottom: 32px;
  right: 12px;
  background: var(--bg-raised);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  min-width: 180px;
  max-width: 240px;
  z-index: 15;
  box-shadow: var(--shadow-lg);
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.detail-type {
  font-size: 9px;
  font-weight: 700;
  color: white;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}

.detail-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;

  &:hover {
    color: var(--text-primary);
  }
}

.detail-label {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--text-xs);
  margin-bottom: 3px;
}

.detail-key {
  color: var(--text-muted);
}

.detail-value {
  color: var(--text-secondary);
  font-family: var(--font-mono);
}

.detail-tokens {
  font-size: var(--text-base);
  font-weight: 700;
  color: var(--text-primary);
}

.detail-badge {
  font-size: 9px;
  color: #fff;
  padding: 1px 5px;
  border-radius: 3px;
}

.detail-btn {
  margin-top: 8px;
  width: 100%;
  padding: 5px 10px;
  font-size: var(--text-xs);
  background: var(--accent-blue);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s;

  &:hover {
    background: #0284c7;
  }
}

// ─── Token 分布条 ───
.token-bar {
  display: flex;
  height: 18px;
  background: var(--bg-field);
  overflow: hidden;
  flex-shrink: 0;
}

.bar-segment {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  white-space: nowrap;
  transition: width 0.3s ease;
}

.bar-text {
  font-size: 8px;
  color: #fff;
  font-weight: 600;
  padding: 0 4px;
}

// ─── Detail Actions ───
.detail-actions {
  display: flex;
  gap: 4px;
  margin-top: 8px;

  .detail-btn {
    flex: 1;
    margin-top: 0;
  }
}

.detail-btn-decompose {
  background: #7c3aed !important;

  &:hover:not(:disabled) {
    background: #6d28d9 !important;
  }

  &:disabled {
    opacity: 0.6;
    cursor: wait;
  }
}

// ─── Decompose Error ───
.decompose-error {
  position: absolute;
  bottom: 32px;
  left: 12px;
  right: 260px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  color: #ef4444;
  z-index: 16;

  span { flex: 1; }

  button {
    background: none;
    border: none;
    color: #ef4444;
    font-size: 16px;
    cursor: pointer;
    padding: 0 4px;
  }
}

// ─── Decompose Overlay ───
.decompose-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}

.decompose-panel {
  background: var(--bg-raised);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-lg, 12px);
  box-shadow: var(--shadow-lg);
  width: 90%;
  max-width: 660px;
  max-height: 85%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.decompose-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-dim);
}

.decompose-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.decompose-badge {
  font-size: 9px;
  font-weight: 700;
  color: white;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}

.decompose-label {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.decompose-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;

  &:hover { color: var(--text-primary); }
}

.decompose-summary {
  padding: 8px 16px;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-dim);
}

.decompose-body {
  flex: 1;
  min-height: 300px;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

.decompose-svg {
  width: 100%;
  height: 100%;
  min-height: 300px;
}

.decompose-list {
  border-top: 1px solid var(--border-dim);
  padding: 8px 16px;
  max-height: 150px;
  overflow-y: auto;
}

.decompose-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: var(--text-xs);
}

.decompose-item-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.decompose-item-label {
  flex: 1;
  color: var(--text-primary);
  font-weight: 500;
}

.decompose-item-type {
  color: var(--text-muted);
  font-size: 9px;
  text-transform: uppercase;
}

.decompose-item-tokens {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-weight: 600;
}
</style>
