import type { ApiRequestsResponse, ApiSummaryResponse, ConversationGroup, ContextInfo, TagsResponse } from './api-types'

const BASE = '' // Vite proxy handles /api/* in dev; same-origin in production

export async function fetchRequests(): Promise<ApiRequestsResponse> {
  const res = await fetch(`${BASE}/api/requests`)
  if (!res.ok) throw new Error(`GET /api/requests failed: ${res.status}`)
  return res.json()
}

export async function fetchSummary(): Promise<ApiSummaryResponse> {
  const res = await fetch(`${BASE}/api/requests?summary=true`)
  if (!res.ok) throw new Error(`GET /api/requests?summary=true failed: ${res.status}`)
  return res.json()
}

export async function fetchConversation(id: string): Promise<ConversationGroup> {
  const res = await fetch(`${BASE}/api/conversations/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`GET /api/conversations/${id} failed: ${res.status}`)
  return res.json()
}

export async function fetchEntryDetail(entryId: number): Promise<ContextInfo | null> {
  const res = await fetch(`${BASE}/api/entries/${entryId}/detail`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /api/entries/${entryId}/detail failed: ${res.status}`)
  const data = await res.json()
  return data.contextInfo ?? null
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`DELETE conversation failed: ${res.status}`)
}

export async function resetAll(): Promise<void> {
  const res = await fetch(`${BASE}/api/reset`, { method: 'POST' })
  if (!res.ok) throw new Error(`POST /api/reset failed: ${res.status}`)
}

export type ExportPrivacy = 'minimal' | 'standard' | 'full'

export function getExportUrl(format: 'lhar' | 'lhar.json', conversationId?: string, privacy?: ExportPrivacy): string {
  const params = new URLSearchParams()
  if (conversationId) params.set('conversation', conversationId)
  if (privacy && privacy !== 'standard') params.set('privacy', privacy)
  const qs = params.toString()
  return `${BASE}/api/export/${format}${qs ? `?${qs}` : ''}`
}

// --- Tags ---

export async function fetchTags(): Promise<TagsResponse> {
  const res = await fetch(`${BASE}/api/tags`)
  if (!res.ok) throw new Error(`GET /api/tags failed: ${res.status}`)
  return res.json()
}

export async function setSessionTags(conversationId: string, tags: string[]): Promise<string[]> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(conversationId)}/tags`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  })
  if (!res.ok) throw new Error(`PATCH tags failed: ${res.status}`)
  const data = await res.json()
  return data.tags
}

export async function addSessionTag(conversationId: string, tag: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(conversationId)}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag }),
  })
  if (!res.ok) throw new Error(`POST tag failed: ${res.status}`)
  const data = await res.json()
  return data.tags
}

export async function removeSessionTag(conversationId: string, tag: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(conversationId)}/tags/${encodeURIComponent(tag)}`, {
    method: 'DELETE',
  })
  if (!res.ok) throw new Error(`DELETE tag failed: ${res.status}`)
  const data = await res.json()
  return data.tags
}

// --- Decompose ---

export interface DecomposeSubNode {
  id: string
  label: string
  type: string
  tokens_estimate: number
  description: string
  importance: number
}

export interface DecomposeResult {
  nodes: DecomposeSubNode[]
  edges: { source: string; target: string; relation: string }[]
  summary: string
  sourceNode: { label: string; category: string; tokens: number }
}

export async function decomposeNode(
  entryId: number,
  category: string
): Promise<DecomposeResult> {
  const res = await fetch(`${BASE}/api/entries/${entryId}/decompose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category })
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `Decompose failed: ${res.status}`)
  }
  return res.json()
}

// --- Proxy Config (API 轮盘) ---

export interface ProxyEndpoint {
  url: string
  apiKey: string
  weight: number
  enabled: boolean
}

export interface ProxyProvider {
  endpoints: ProxyEndpoint[]
  strategy: 'weighted' | 'round-robin' | 'failover'
}

export interface ProxyConfig {
  providers: Record<string, ProxyProvider>
  updatedAt: string
}

export async function fetchProxyConfig(): Promise<ProxyConfig> {
  const res = await fetch(`${BASE}/api/config/proxy`)
  if (!res.ok) throw new Error(`GET /api/config/proxy failed: ${res.status}`)
  return res.json()
}

export async function saveProxyConfig(config: ProxyConfig): Promise<void> {
  const res = await fetch(`${BASE}/api/config/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) throw new Error(`POST /api/config/proxy failed: ${res.status}`)
}

export async function restartProxy(): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`${BASE}/api/config/proxy/restart`, { method: 'POST' })
  if (!res.ok) throw new Error(`POST /api/config/proxy/restart failed: ${res.status}`)
  return res.json()
}

export async function getProxyStatus(): Promise<{ running: boolean; pid?: number }> {
  const res = await fetch(`${BASE}/api/config/proxy/status`)
  if (!res.ok) throw new Error(`GET /api/config/proxy/status failed: ${res.status}`)
  return res.json()
}

// --- OpenClaw Models Config ---

export interface ModelInfo {
  id: string
  name: string
}

export interface OpenClawProvider {
  baseUrl: string
  apiKey: string
  api: string
  models: ModelInfo[]
}

export interface ModelsConfig {
  providers: Record<string, OpenClawProvider>
  primary: string
  compaction: string
}

export async function fetchModelsConfig(): Promise<ModelsConfig> {
  const res = await fetch(`${BASE}/api/config/models`)
  if (!res.ok) throw new Error(`GET /api/config/models failed: ${res.status}`)
  return res.json()
}

export async function saveModelsConfig(config: {
  providers: Record<string, OpenClawProvider>
  primary: string
  compaction: string
}): Promise<void> {
  const res = await fetch(`${BASE}/api/config/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) throw new Error(`POST /api/config/models failed: ${res.status}`)
}

export async function listProviderModels(baseUrl: string, apiKey: string, api: string): Promise<ModelInfo[]> {
  const res = await fetch(`${BASE}/api/config/models/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl, apiKey, api }),
  })
  if (!res.ok) throw new Error(`POST /api/config/models/list failed: ${res.status}`)
  const data = await res.json()
  return data.models
}

// --- MotoMap by Visurf Integration ---

const VISURF_DEFAULT_URL = 'http://localhost:4000'

export async function sendToVisurf(
  session: ConversationGroup,
  visurfUrl = VISURF_DEFAULT_URL
): Promise<{ ok: boolean; nodeId?: string; error?: string }> {
  // Convert Context Lens session to Visurf ingest format
  const payload = {
    provider: session.source || 'unknown',
    sessionId: session.id,
    requestBody: {
      model: session.entries[0]?.contextInfo?.model || 'unknown',
    },
    usage: {
      total_tokens: session.entries.reduce((sum, e) => sum + (e.usage?.inputTokens || 0) + (e.usage?.outputTokens || 0), 0),
    },
    timings: {
      total_ms: session.entries.reduce((sum, e) => sum + (e.timings?.total_ms || 0), 0),
    },
    // Include full session data for richer visualization
    contextLens: {
      id: session.id,
      source: session.source,
      workingDirectory: session.workingDirectory,
      entryCount: session.entries.length,
      entries: session.entries.map(e => ({
        id: e.id,
        model: e.contextInfo?.model,
        inputTokens: e.usage?.inputTokens,
        outputTokens: e.usage?.outputTokens,
        latencyMs: e.timings?.total_ms,
        timestamp: e.timestamp,
      })),
    },
  }

  const res = await fetch(`${visurfUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}` }
  }

  return res.json()
}
