<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import type { ProjectedEntry, CompositionEntry } from '@/api-types'

const store = useSessionStore()
const svgRef = ref<SVGSVGElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)

// Graph data
interface GraphNode {
  id: string
  type: 'session' | 'model' | 'turn' | 'tool' | 'category'
  label: string
  tokens?: number
  cost?: number
  x: number
  y: number
  vx: number
  vy: number
  fx?: number | null
  fy?: number | null
  color: string
  radius: number
}

interface GraphEdge {
  source: string
  target: string
  weight: number
  color: string
}

const nodes = ref<GraphNode[]>([])
const edges = ref<GraphEdge[]>([])
const hoveredNode = ref<GraphNode | null>(null)
const selectedNode = ref<GraphNode | null>(null)

// Force simulation parameters
const width = ref(800)
const height = ref(600)
let animationFrame: number | null = null

// Color mapping
const typeColors: Record<string, string> = {
  session: '#3b82f6',   // blue
  model: '#8b5cf6',     // purple
  turn: '#10b981',      // green
  tool: '#f59e0b',      // amber
  category: '#ec4899',  // pink
}

const categoryColors: Record<string, string> = {
  system_prompt: '#6366f1',
  tool_definitions: '#8b5cf6',
  tool_results: '#f59e0b',
  tool_calls: '#ef4444',
  assistant_text: '#10b981',
  user_text: '#3b82f6',
  thinking: '#ec4899',
  images: '#14b8a6',
  other: '#6b7280',
}

// Build graph from session data
function buildGraph() {
  const session = store.selectedSession
  if (!session) {
    nodes.value = []
    edges.value = []
    return
  }

  const newNodes: GraphNode[] = []
  const newEdges: GraphEdge[] = []
  const centerX = width.value / 2
  const centerY = height.value / 2

  // Session root node
  const sessionNode: GraphNode = {
    id: 'session',
    type: 'session',
    label: session.id.slice(0, 8),
    x: centerX,
    y: centerY,
    vx: 0,
    vy: 0,
    fx: centerX,
    fy: centerY,
    color: typeColors.session,
    radius: 30,
  }
  newNodes.push(sessionNode)

  // Group entries by model
  const modelMap = new Map<string, ProjectedEntry[]>()
  for (const entry of session.entries) {
    const model = entry.contextInfo?.model || 'unknown'
    if (!modelMap.has(model)) {
      modelMap.set(model, [])
    }
    modelMap.get(model)!.push(entry)
  }

  // Create model nodes
  let modelIndex = 0
  const modelNodeMap = new Map<string, GraphNode>()
  for (const [model, entries] of modelMap) {
    const angle = (2 * Math.PI * modelIndex) / modelMap.size
    const distance = 150
    const modelNode: GraphNode = {
      id: `model-${model}`,
      type: 'model',
      label: model.split('/').pop() || model,
      tokens: entries.reduce((sum, e) => sum + (e.contextInfo?.totalTokens || 0), 0),
      x: centerX + Math.cos(angle) * distance,
      y: centerY + Math.sin(angle) * distance,
      vx: 0,
      vy: 0,
      color: typeColors.model,
      radius: 20 + Math.min(entries.length * 2, 20),
    }
    newNodes.push(modelNode)
    modelNodeMap.set(model, modelNode)

    newEdges.push({
      source: 'session',
      target: modelNode.id,
      weight: entries.length,
      color: 'rgba(139, 92, 246, 0.4)',
    })

    modelIndex++
  }

  // Create turn nodes for each entry
  let turnIndex = 0
  for (const entry of session.entries.slice().reverse()) {
    const model = entry.contextInfo?.model || 'unknown'
    const modelNode = modelNodeMap.get(model)!
    const angle = (2 * Math.PI * turnIndex) / session.entries.length + Math.random() * 0.5
    const distance = 100 + Math.random() * 50

    const turnNode: GraphNode = {
      id: `turn-${entry.id}`,
      type: 'turn',
      label: `T${turnIndex + 1}`,
      tokens: entry.contextInfo?.totalTokens || 0,
      cost: entry.costUsd || 0,
      x: modelNode.x + Math.cos(angle) * distance,
      y: modelNode.y + Math.sin(angle) * distance,
      vx: 0,
      vy: 0,
      color: typeColors.turn,
      radius: 8 + Math.min(Math.sqrt(entry.contextInfo?.totalTokens || 0) / 20, 15),
    }
    newNodes.push(turnNode)

    newEdges.push({
      source: modelNode.id,
      target: turnNode.id,
      weight: 1,
      color: 'rgba(16, 185, 129, 0.3)',
    })

    // Add category nodes for composition
    if (entry.composition && entry.composition.length > 0) {
      for (const comp of entry.composition) {
        if (comp.tokens > 100) {  // Only show significant categories
          const catId = `cat-${entry.id}-${comp.category}`
          const catAngle = Math.random() * 2 * Math.PI
          const catDistance = 40 + Math.random() * 20

          const catNode: GraphNode = {
            id: catId,
            type: 'category',
            label: comp.category.replace(/_/g, ' ').slice(0, 10),
            tokens: comp.tokens,
            x: turnNode.x + Math.cos(catAngle) * catDistance,
            y: turnNode.y + Math.sin(catAngle) * catDistance,
            vx: 0,
            vy: 0,
            color: categoryColors[comp.category] || categoryColors.other,
            radius: 4 + Math.min(Math.sqrt(comp.tokens) / 10, 10),
          }
          newNodes.push(catNode)

          newEdges.push({
            source: turnNode.id,
            target: catId,
            weight: comp.pct,
            color: `${categoryColors[comp.category] || categoryColors.other}40`,
          })
        }
      }
    }

    turnIndex++
  }

  nodes.value = newNodes
  edges.value = newEdges
}

// Simple force simulation
function tick() {
  const alpha = 0.1
  const repulsion = 500
  const attraction = 0.01
  const damping = 0.9

  // Apply forces
  for (const node of nodes.value) {
    if (node.fx !== undefined && node.fx !== null) continue

    // Repulsion from other nodes
    for (const other of nodes.value) {
      if (node.id === other.id) continue
      const dx = node.x - other.x
      const dy = node.y - other.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const force = repulsion / (dist * dist)
      node.vx += (dx / dist) * force * alpha
      node.vy += (dy / dist) * force * alpha
    }

    // Attraction to connected nodes (via edges)
    for (const edge of edges.value) {
      let other: GraphNode | undefined
      if (edge.source === node.id) {
        other = nodes.value.find(n => n.id === edge.target)
      } else if (edge.target === node.id) {
        other = nodes.value.find(n => n.id === edge.source)
      }
      if (other) {
        const dx = other.x - node.x
        const dy = other.y - node.y
        node.vx += dx * attraction * alpha
        node.vy += dy * attraction * alpha
      }
    }

    // Center gravity
    const centerX = width.value / 2
    const centerY = height.value / 2
    node.vx += (centerX - node.x) * 0.001
    node.vy += (centerY - node.y) * 0.001

    // Apply velocity with damping
    node.vx *= damping
    node.vy *= damping
    node.x += node.vx
    node.y += node.vy

    // Boundary constraints
    node.x = Math.max(node.radius, Math.min(width.value - node.radius, node.x))
    node.y = Math.max(node.radius, Math.min(height.value - node.radius, node.y))
  }

  animationFrame = requestAnimationFrame(tick)
}

function updateSize() {
  if (containerRef.value) {
    width.value = containerRef.value.clientWidth
    height.value = containerRef.value.clientHeight
  }
}

function onNodeHover(node: GraphNode | null) {
  hoveredNode.value = node
}

function onNodeClick(node: GraphNode) {
  selectedNode.value = selectedNode.value?.id === node.id ? null : node

  // If it's a turn node, focus in Messages tab
  if (node.type === 'turn') {
    const entryId = parseInt(node.id.replace('turn-', ''))
    store.pinEntry(entryId)
  }
}

// Computed for SVG rendering
interface EdgePath extends GraphEdge {
  x1: number
  y1: number
  x2: number
  y2: number
}

const edgePaths = computed<EdgePath[]>(() => {
  const result: EdgePath[] = []
  for (const edge of edges.value) {
    const source = nodes.value.find(n => n.id === edge.source)
    const target = nodes.value.find(n => n.id === edge.target)
    if (source && target) {
      result.push({
        ...edge,
        x1: source.x,
        y1: source.y,
        x2: target.x,
        y2: target.y,
      })
    }
  }
  return result
})

watch(() => store.selectedSession, () => {
  buildGraph()
}, { immediate: true })

onMounted(() => {
  updateSize()
  window.addEventListener('resize', updateSize)
  buildGraph()
  tick()
})

onUnmounted(() => {
  window.removeEventListener('resize', updateSize)
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
  }
})
</script>

<template>
  <div class="visurf-tab" ref="containerRef">
    <div class="visurf-header">
      <h3>Session Map</h3>
      <div class="visurf-legend">
        <span class="legend-item"><span class="dot" style="background: #3b82f6"></span>Session</span>
        <span class="legend-item"><span class="dot" style="background: #8b5cf6"></span>Model</span>
        <span class="legend-item"><span class="dot" style="background: #10b981"></span>Turn</span>
        <span class="legend-item"><span class="dot" style="background: #ec4899"></span>Category</span>
      </div>
    </div>

    <svg ref="svgRef" :width="width" :height="height" class="visurf-svg">
      <!-- Edges -->
      <g class="edges">
        <line
          v-for="edge in edgePaths"
          :key="`${edge.source}-${edge.target}`"
          :x1="edge.x1"
          :y1="edge.y1"
          :x2="edge.x2"
          :y2="edge.y2"
          :stroke="edge.color"
          :stroke-width="Math.max(1, edge.weight / 2)"
        />
      </g>

      <!-- Nodes -->
      <g class="nodes">
        <g
          v-for="node in nodes"
          :key="node.id"
          class="node"
          :class="{ hovered: hoveredNode?.id === node.id, selected: selectedNode?.id === node.id }"
          :transform="`translate(${node.x}, ${node.y})`"
          @mouseenter="onNodeHover(node)"
          @mouseleave="onNodeHover(null)"
          @click="onNodeClick(node)"
        >
          <circle
            :r="node.radius"
            :fill="node.color"
            :stroke="selectedNode?.id === node.id ? '#fff' : 'transparent'"
            stroke-width="2"
          />
          <text
            v-if="node.radius > 10"
            :y="4"
            text-anchor="middle"
            class="node-label"
          >
            {{ node.label }}
          </text>
        </g>
      </g>
    </svg>

    <!-- Tooltip -->
    <div
      v-if="hoveredNode"
      class="tooltip"
      :style="{
        left: `${hoveredNode.x + 20}px`,
        top: `${hoveredNode.y - 10}px`
      }"
    >
      <div class="tooltip-title">{{ hoveredNode.label }}</div>
      <div class="tooltip-type">{{ hoveredNode.type }}</div>
      <div v-if="hoveredNode.tokens" class="tooltip-stat">
        {{ hoveredNode.tokens.toLocaleString() }} tokens
      </div>
      <div v-if="hoveredNode.cost" class="tooltip-stat">
        ${{ hoveredNode.cost.toFixed(4) }}
      </div>
    </div>

    <!-- Selected node detail -->
    <div v-if="selectedNode" class="detail-panel">
      <div class="detail-header">
        <span class="detail-type" :style="{ background: selectedNode.color }">
          {{ selectedNode.type }}
        </span>
        <span class="detail-label">{{ selectedNode.label }}</span>
      </div>
      <div v-if="selectedNode.tokens" class="detail-row">
        <span class="detail-key">Tokens</span>
        <span class="detail-value">{{ selectedNode.tokens.toLocaleString() }}</span>
      </div>
      <div v-if="selectedNode.cost" class="detail-row">
        <span class="detail-key">Cost</span>
        <span class="detail-value">${{ selectedNode.cost.toFixed(4) }}</span>
      </div>
      <button v-if="selectedNode.type === 'turn'" class="detail-btn" @click="store.setInspectorTab('messages')">
        View in Messages
      </button>
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
}

.visurf-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  padding: 12px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: linear-gradient(180deg, var(--bg-deep) 60%, transparent);
  z-index: 10;

  h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }
}

.visurf-legend {
  display: flex;
  gap: 12px;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--text-muted);

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
}

.visurf-svg {
  width: 100%;
  height: 100%;
}

.node {
  cursor: pointer;
  transition: transform 0.1s;

  &:hover {
    transform: scale(1.1);
  }

  &.selected circle {
    filter: drop-shadow(0 0 8px currentColor);
  }
}

.node-label {
  font-size: 10px;
  fill: white;
  font-weight: 500;
  pointer-events: none;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

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
}

.tooltip-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.tooltip-type {
  font-size: var(--text-xs);
  color: var(--text-muted);
  text-transform: capitalize;
  margin-bottom: 4px;
}

.tooltip-stat {
  font-size: var(--text-xs);
  color: var(--text-dim);
  font-family: var(--font-mono);
}

.detail-panel {
  position: absolute;
  bottom: 16px;
  right: 16px;
  background: var(--bg-raised);
  border: 1px solid var(--border-mid);
  border-radius: var(--radius-md);
  padding: 12px 16px;
  min-width: 180px;
  z-index: 15;
  box-shadow: var(--shadow-lg);
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.detail-type {
  font-size: 10px;
  font-weight: 600;
  color: white;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}

.detail-label {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.detail-row {
  display: flex;
  justify-content: space-between;
  font-size: var(--text-xs);
  margin-bottom: 4px;
}

.detail-key {
  color: var(--text-muted);
}

.detail-value {
  color: var(--text-secondary);
  font-family: var(--font-mono);
}

.detail-btn {
  margin-top: 8px;
  width: 100%;
  padding: 6px 12px;
  font-size: var(--text-xs);
  background: var(--accent-blue);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s;

  &:hover {
    background: var(--accent-blue-hover, #2563eb);
  }
}
</style>
