<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  fetchProxyConfig,
  saveProxyConfig,
  restartProxy,
  getProxyStatus,
} from '@/api'
import type { ProxyConfig, ProxyEndpoint, ProxyProvider } from '@/api'

const config = ref<ProxyConfig>({
  providers: {},
  updatedAt: '',
})
const proxyRunning = ref(false)
const proxyPid = ref<number | undefined>()
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)

const strategies: { value: ProxyProvider['strategy']; label: string }[] = [
  { value: 'failover', label: 'Failover' },
  { value: 'weighted', label: 'Weighted' },
  { value: 'round-robin', label: 'Round Robin' },
]

const defaultProviders = ['anthropic', 'openai', 'gemini']

async function loadConfig() {
  loading.value = true
  error.value = null
  try {
    const [cfg, status] = await Promise.all([fetchProxyConfig(), getProxyStatus()])
    config.value = cfg
    proxyRunning.value = status.running
    proxyPid.value = status.pid
    // Ensure default providers exist
    for (const name of defaultProviders) {
      if (!config.value.providers[name]) {
        config.value.providers[name] = { endpoints: [], strategy: 'failover' }
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function addEndpoint(providerName: string) {
  const provider = config.value.providers[providerName]
  if (!provider) return
  provider.endpoints.push({
    url: '',
    apiKey: '',
    weight: 100,
    enabled: true,
  })
}

function removeEndpoint(providerName: string, index: number) {
  const provider = config.value.providers[providerName]
  if (!provider) return
  provider.endpoints.splice(index, 1)
}

function addProvider() {
  const name = prompt('Provider name (e.g. vertex, chatgpt):')
  if (!name || config.value.providers[name]) return
  config.value.providers[name] = { endpoints: [], strategy: 'failover' }
}

async function handleSave() {
  saving.value = true
  error.value = null
  successMessage.value = null
  try {
    await saveProxyConfig(config.value)
    successMessage.value = 'Config saved'
    setTimeout(() => { successMessage.value = null }, 2000)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function handleSaveAndRestart() {
  saving.value = true
  error.value = null
  successMessage.value = null
  try {
    await saveProxyConfig(config.value)
    const result = await restartProxy()
    successMessage.value = result.ok ? 'Saved & restarted' : 'Saved (restart issue)'
    // Refresh status after a short delay
    setTimeout(async () => {
      const status = await getProxyStatus()
      proxyRunning.value = status.running
      proxyPid.value = status.pid
      successMessage.value = null
    }, 1500)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

onMounted(loadConfig)
</script>

<template>
  <div class="settings-tab">
    <div class="settings-header">
      <h2 class="settings-title">Settings</h2>
      <span class="settings-sub">API Proxy Configuration</span>
    </div>

    <div v-if="loading" class="settings-loading">Loading config...</div>
    <div v-else-if="error" class="settings-error">
      <i class="i-carbon-warning-alt" /> {{ error }}
    </div>

    <template v-if="!loading">
      <div
        v-for="(provider, providerName) in config.providers"
        :key="providerName"
        class="provider-card"
      >
        <div class="provider-header">
          <span class="provider-name">{{ providerName }}</span>
          <select
            v-model="provider.strategy"
            class="strategy-select"
          >
            <option
              v-for="s in strategies"
              :key="s.value"
              :value="s.value"
            >{{ s.label }}</option>
          </select>
        </div>

        <div class="endpoints-list">
          <div
            v-for="(ep, idx) in provider.endpoints"
            :key="idx"
            class="endpoint-row"
            :class="{ disabled: !ep.enabled }"
          >
            <div class="endpoint-main">
              <label class="toggle-label">
                <input
                  type="checkbox"
                  v-model="ep.enabled"
                  class="toggle-input"
                />
                <span class="toggle-dot" :class="{ on: ep.enabled }" />
              </label>
              <input
                v-model="ep.url"
                class="ep-url"
                placeholder="https://api.example.com"
              />
              <button class="remove-btn" title="Remove" @click="removeEndpoint(providerName as string, idx)">
                <i class="i-carbon-close" />
              </button>
            </div>
            <div class="endpoint-detail">
              <label class="ep-label">Key</label>
              <input
                v-model="ep.apiKey"
                class="ep-key"
                type="password"
                placeholder="sk-..."
              />
              <label class="ep-label">Weight</label>
              <input
                v-model.number="ep.weight"
                class="ep-weight"
                type="number"
                min="0"
                max="100"
              />
            </div>
          </div>

          <button class="add-endpoint-btn" @click="addEndpoint(providerName as string)">
            <i class="i-carbon-add" /> Add Endpoint
          </button>
        </div>
      </div>

      <button class="add-provider-btn" @click="addProvider">
        <i class="i-carbon-add-alt" /> Add Provider
      </button>

      <!-- Connection info -->
      <div class="connect-card">
        <div class="connect-header">
          <i class="i-carbon-connect" /> External Connection
        </div>
        <div class="connect-body">
          <div class="connect-row">
            <span class="connect-label">Proxy URL</span>
            <code class="connect-value">http://localhost:4040</code>
          </div>
          <div class="connect-row">
            <span class="connect-label">Claude Code</span>
            <code class="connect-value">ANTHROPIC_BASE_URL=http://localhost:4040</code>
          </div>
          <div class="connect-row">
            <span class="connect-label">OpenAI SDK</span>
            <code class="connect-value">OPENAI_BASE_URL=http://localhost:4040</code>
          </div>
          <div class="connect-hint">
            Set these env vars in your terminal, then AI tools will route through MotoMap proxy.
          </div>
        </div>
      </div>

      <!-- Proxy status + actions -->
      <div class="proxy-footer">
        <div class="proxy-status">
          <span class="status-dot" :class="{ running: proxyRunning }" />
          Proxy: {{ proxyRunning ? `Running (PID ${proxyPid})` : 'Stopped' }}
        </div>
        <div class="footer-actions">
          <span v-if="successMessage" class="success-msg">{{ successMessage }}</span>
          <button class="save-btn" :disabled="saving" @click="handleSave">
            <i class="i-carbon-save" /> Save
          </button>
          <button class="restart-btn" :disabled="saving" @click="handleSaveAndRestart">
            <i class="i-carbon-restart" /> Save & Restart Proxy
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
@use '../styles/mixins' as *;

.settings-tab {
  padding: var(--space-5);
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.settings-header {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}

.settings-title {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.settings-sub {
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.settings-loading {
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-dim);
  padding: var(--space-6) 0;
}

.settings-error {
  font-size: var(--text-sm);
  color: var(--accent-red);
  background: var(--accent-red-dim);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

// Provider card
.provider-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.provider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-field);
  border-bottom: 1px solid var(--border-dim);
}

.provider-name {
  font-weight: 600;
  font-size: var(--text-base);
  color: var(--text-primary);
  text-transform: capitalize;
}

.strategy-select {
  @include mono-text;
  font-size: var(--text-xs);
  background: var(--bg-raised);
  color: var(--text-secondary);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  padding: 3px 8px;
  cursor: pointer;

  &:focus-visible { @include focus-ring; }
}

.endpoints-list {
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.endpoint-row {
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  transition: opacity 0.15s;

  &.disabled { opacity: 0.5; }
}

.endpoint-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.toggle-label {
  display: flex;
  cursor: pointer;
  flex-shrink: 0;
}

.toggle-input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-ghost);
  transition: background 0.15s;

  &.on { background: var(--accent-green); box-shadow: 0 0 4px var(--accent-green); }
}

.ep-url {
  flex: 1;
  @include mono-text;
  font-size: var(--text-sm);
  background: var(--bg-field);
  color: var(--text-primary);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  padding: 4px 8px;

  &:focus { border-color: var(--accent-blue); outline: none; }
}

.remove-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  font-size: 12px;
  border-radius: var(--radius-sm);

  &:hover { color: var(--accent-red); background: var(--accent-red-dim); }
}

.endpoint-detail {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-left: 18px;
}

.ep-label {
  font-size: var(--text-xs);
  color: var(--text-muted);
  flex-shrink: 0;
}

.ep-key {
  flex: 1;
  @include mono-text;
  font-size: var(--text-xs);
  background: var(--bg-field);
  color: var(--text-secondary);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  padding: 3px 6px;

  &:focus { border-color: var(--accent-blue); outline: none; }
}

.ep-weight {
  width: 50px;
  @include mono-text;
  font-size: var(--text-xs);
  background: var(--bg-field);
  color: var(--text-secondary);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-sm);
  padding: 3px 6px;
  text-align: center;

  &:focus { border-color: var(--accent-blue); outline: none; }
}

.add-endpoint-btn,
.add-provider-btn {
  font-size: var(--text-xs);
  color: var(--accent-blue);
  background: none;
  border: 1px dashed var(--border-dim);
  border-radius: var(--radius-sm);
  padding: 6px 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: border-color 0.12s, background 0.12s;

  &:hover {
    border-color: var(--accent-blue);
    background: var(--accent-blue-dim);
  }
}

.add-provider-btn {
  align-self: flex-start;
}

// Connection info card
.connect-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.connect-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--bg-field);
  border-bottom: 1px solid var(--border-dim);
  font-weight: 600;
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.connect-body {
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.connect-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.connect-label {
  font-size: var(--text-xs);
  color: var(--text-muted);
  min-width: 80px;
  flex-shrink: 0;
}

.connect-value {
  @include mono-text;
  font-size: var(--text-xs);
  color: var(--accent-blue);
  background: var(--accent-blue-dim);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  user-select: all;
}

.connect-hint {
  font-size: var(--text-xs);
  color: var(--text-ghost);
  margin-top: var(--space-1);
}

// Footer
.proxy-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-surface);
  border: 1px solid var(--border-dim);
  border-radius: var(--radius-md);
}

.proxy-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  @include mono-text;
  font-size: var(--text-sm);
  color: var(--text-dim);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-red);

  &.running {
    background: var(--accent-green);
    box-shadow: 0 0 6px var(--accent-green);
  }
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.success-msg {
  font-size: var(--text-xs);
  color: var(--accent-green);
  @include mono-text;
}

.save-btn,
.restart-btn {
  font-size: var(--text-xs);
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: background 0.12s, border-color 0.12s;

  &:disabled { opacity: 0.5; cursor: default; }
}

.save-btn {
  background: var(--bg-raised);
  border: 1px solid var(--border-dim);
  color: var(--text-secondary);

  &:hover:not(:disabled) {
    border-color: var(--border-mid);
    color: var(--text-primary);
  }
}

.restart-btn {
  background: var(--accent-blue-dim);
  border: 1px solid var(--accent-blue);
  color: var(--accent-blue);

  &:hover:not(:disabled) {
    background: rgba(14, 165, 233, 0.25);
  }
}
</style>
