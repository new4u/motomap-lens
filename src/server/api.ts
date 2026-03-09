import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "@contextio/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as v from "valibot";

import { ingestCapture } from "../analysis/ingest.js";
import { parseContextInfo } from "../core.js";
import { toLharJson, toLharJsonl } from "../lhar.js";
import type { ProxyConfigFile } from "../proxy/config.js";
import {
  PROXY_CONFIG_DIR,
  PROXY_CONFIG_PATH,
  readProxyConfigFile,
} from "../proxy/config.js";
import {
  IngestCapturePayloadSchema,
  IngestLegacyPayloadSchema,
} from "../schemas.js";
import type {
  AgentGroup,
  CapturedEntry,
  ContextInfo,
  Conversation,
  ConversationGroup,
  PrivacyLevel,
} from "../types.js";
import { projectEntry } from "./projection.js";
import type { Store } from "./store.js";

// ═══ Decompose helpers ═══

interface DecomposeSubNode {
  id: string;
  label: string;
  type: string;
  tokens_estimate: number;
  description: string;
  importance: number;
}

interface DecomposeResult {
  nodes: DecomposeSubNode[];
  edges: { source: string; target: string; relation: string }[];
  summary: string;
  sourceNode: { label: string; category: string; tokens: number };
}

function extractCategoryContent(
  contextInfo: ContextInfo,
  category: string,
): string {
  switch (category) {
    case "system_prompt":
    case "system_injections":
      return contextInfo.systemPrompts.map((s) => s.content).join("\n---\n");

    case "tool_definitions":
      return contextInfo.tools
        .map((t) => {
          if ("function" in t && t.function) {
            return `[${t.function.name}] ${t.function.description || ""}`;
          }
          const at = t as { name: string; description?: string };
          return `[${at.name}] ${at.description || ""}`;
        })
        .join("\n");

    case "user_text":
      return contextInfo.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n---\n");

    case "assistant_text":
      return contextInfo.messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.content)
        .join("\n---\n");

    case "tool_calls":
      return contextInfo.messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) =>
          (m.contentBlocks || [])
            .filter((b) => b.type === "tool_use")
            .map(
              (b) =>
                `[${(b as { name: string }).name}] ${JSON.stringify((b as { input: unknown }).input).slice(0, 500)}`,
            ),
        )
        .join("\n");

    case "tool_results":
      return contextInfo.messages
        .filter((m) => m.role === "tool")
        .map((m) => m.content)
        .join("\n---\n");

    case "thinking":
      return contextInfo.messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) =>
          (m.contentBlocks || [])
            .filter(
              (b) =>
                b.type === "text" &&
                (b as { text: string }).text?.startsWith("<thinking"),
            )
            .map((b) => (b as { text: string }).text),
        )
        .join("\n");

    default:
      return contextInfo.messages.map((m) => m.content).join("\n---\n");
  }
}

function buildDecomposePrompt(category: string, content: string): string {
  // Truncate content to avoid excessive tokens
  const truncated =
    content.length > 4000
      ? `${content.slice(0, 4000)}\n...[truncated]`
      : content;

  return `You are analyzing a section of an AI conversation context window.

Category: ${category}
Content:
---
${truncated}
---

Decompose this content into 3-8 semantic sub-components. For each, identify:
- label: short name (2-5 words)
- type: one of "instruction", "data", "code", "query", "response", "metadata", "tool", "reasoning"
- tokens_estimate: approximate token count
- description: one sentence explaining what this sub-component does
- importance: 0.0 to 1.0 (how critical is this to the conversation)

Also provide:
- edges: semantic relationships between sub-components (source_id → target_id with relation label)
- summary: one sentence summarizing the overall content

Return ONLY valid JSON in this exact format:
{
  "nodes": [
    { "id": "n1", "label": "...", "type": "...", "tokens_estimate": 100, "description": "...", "importance": 0.8 }
  ],
  "edges": [
    { "source": "n1", "target": "n2", "relation": "depends_on" }
  ],
  "summary": "..."
}`;
}

function parseDecomposeResponse(
  llmResult: Record<string, unknown>,
): DecomposeResult | { error: string } {
  try {
    // Extract text content from Claude API response
    const content = llmResult.content as Array<{ type: string; text?: string }>;
    if (!content || !Array.isArray(content)) {
      return { error: "Invalid LLM response format" };
    }
    const textBlock = content.find((b) => b.type === "text");
    if (!textBlock?.text) {
      return { error: "No text in LLM response" };
    }

    // Extract JSON from response (may be wrapped in markdown code blocks)
    let jsonStr = textBlock.text.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const parsed = JSON.parse(jsonStr);
    return {
      nodes: parsed.nodes || [],
      edges: parsed.edges || [],
      summary: parsed.summary || "",
      sourceNode: { label: "", category: "", tokens: 0 },
    };
  } catch (e) {
    return { error: `Failed to parse LLM response: ${e}` };
  }
}

function projectEntryForApi(e: CapturedEntry) {
  return projectEntry(e, e.contextInfo);
}

function getExportEntries(
  store: Store,
  conversation?: string,
): CapturedEntry[] {
  if (!conversation) return store.getCapturedRequests();
  return store
    .getCapturedRequests()
    .filter((e) => e.conversationId === conversation);
}

function sanitizeFilenamePart(
  input: string | null | undefined,
  fallback: string,
): string {
  const sanitized = String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
}

function buildExportFilename(
  format: "lhar" | "lhar.json",
  conversation: string | null | undefined,
  privacy: PrivacyLevel,
): string {
  const sessionPart = `session-${sanitizeFilenamePart(conversation, "all")}`;
  const privacyPart = `privacy-${sanitizeFilenamePart(privacy, "standard")}`;
  const ext = format === "lhar" ? "lhar" : "lhar.json";
  return `motomap-export-${sessionPart}-${privacyPart}.${ext}`;
}

/**
 * Group captured requests into conversations with agents.
 * Shared by both full and summary endpoints.
 */
function buildConversationGroups(store: Store): {
  grouped: Map<string, CapturedEntry[]>;
  ungrouped: CapturedEntry[];
} {
  const capturedRequests = store.getCapturedRequests();
  const grouped = new Map<string, CapturedEntry[]>();
  const ungrouped: CapturedEntry[] = [];
  for (const entry of capturedRequests) {
    if (entry.conversationId) {
      if (!grouped.has(entry.conversationId))
        grouped.set(entry.conversationId, []);
      grouped.get(entry.conversationId)?.push(entry);
    } else {
      ungrouped.push(entry);
    }
  }
  return { grouped, ungrouped };
}

function buildFullConversation(
  id: string,
  entries: CapturedEntry[],
  conversations: Map<string, Conversation>,
  store: Store,
): ConversationGroup {
  // Sort newest-first (by timestamp descending) for consistent API output.
  // The UI and scrubber expect entries[0] to be the latest turn.
  const sorted = [...entries].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const meta = conversations.get(id) || {
    id,
    label: "Unknown",
    source: "unknown",
    workingDirectory: null,
    firstSeen: sorted[sorted.length - 1].timestamp,
  };

  // Get tags for this conversation
  const tags = store.getTags(id);

  const agentMap = new Map<string, CapturedEntry[]>();
  for (const e of sorted) {
    const ak = e.agentKey || "_default";
    if (!agentMap.has(ak)) agentMap.set(ak, []);
    agentMap.get(ak)?.push(e);
  }
  const agents: AgentGroup[] = [];
  for (const [_ak, agentEntries] of agentMap) {
    agents.push({
      key: _ak,
      label: agentEntries[agentEntries.length - 1].agentLabel || "Unnamed",
      model: agentEntries[0].contextInfo.model,
      entries: agentEntries.map(projectEntryForApi),
    });
  }
  agents.sort(
    (a, b) =>
      new Date(b.entries[0].timestamp).getTime() -
      new Date(a.entries[0].timestamp).getTime(),
  );
  return {
    ...meta,
    tags,
    agents,
    entries: sorted.map(projectEntryForApi),
  };
}

/**
 * Create the Hono app with all API routes.
 */
export function createApiApp(store: Store): Hono {
  const app = new Hono();

  // --- Health ---

  app.get("/health", (c) => c.json({ status: "ok" }));

  // --- Ingest ---

  app.post("/api/ingest", async (c) => {
    const raw = await c.req.json();

    // Try capture format first (from mitmproxy addon), then legacy format
    const captureResult = v.safeParse(IngestCapturePayloadSchema, raw);
    if (captureResult.success) {
      const data = captureResult.output;
      ingestCapture(store, {
        ...data,
        source: data.source ?? "unknown",
        requestBody: (data.requestBody ?? null) as JsonValue | null,
      });
      console.log(
        `  📥 Ingested (capture): [${data.provider}] from ${data.source ?? "unknown"}`,
      );
      return c.json({ ok: true });
    }

    const legacyResult = v.safeParse(IngestLegacyPayloadSchema, raw);
    if (legacyResult.success) {
      const data = legacyResult.output;
      const contextInfo = parseContextInfo(
        data.provider,
        data.body,
        data.apiFormat,
      );
      store.storeRequest(contextInfo, data.response, data.source, data.body);
      console.log(
        `  📥 Ingested: [${data.provider}] ${contextInfo.model} from ${data.source}`,
      );
      return c.json({ ok: true });
    }

    const message = v.summarize(legacyResult.issues);
    console.error("Ingest validation error:", message);
    return c.json({ error: message }, 400);
  });

  // --- Entry detail ---

  app.get("/api/entries/:id/detail", (c) => {
    const entryId = parseInt(c.req.param("id"), 10);
    const contextInfo = store.getEntryDetail(entryId);
    if (contextInfo) {
      return c.json({ contextInfo });
    }
    return c.json({ error: "Detail not found for this entry" }, 404);
  });

  // --- Decompose node (LLM-powered) ---

  app.post("/api/entries/:id/decompose", async (c) => {
    const entryId = parseInt(c.req.param("id"), 10);
    const { category } = await c.req.json();

    if (!category) {
      return c.json({ error: "category is required" }, 400);
    }

    const contextInfo = store.getEntryDetail(entryId);
    if (!contextInfo) {
      return c.json({ error: "Entry not found" }, 404);
    }

    const content = extractCategoryContent(contextInfo, category);
    if (!content || content.trim().length === 0) {
      return c.json({ error: "No content found for this category" }, 404);
    }

    const proxyUrl = process.env.DECOMPOSE_LLM_URL || "http://localhost:4040";
    const apiKey =
      process.env.DECOMPOSE_API_KEY || process.env.ANTHROPIC_API_KEY || "";

    if (!apiKey) {
      return c.json(
        {
          error:
            "No API key configured (set DECOMPOSE_API_KEY or ANTHROPIC_API_KEY)",
        },
        500,
      );
    }

    try {
      const llmResponse = await fetch(`${proxyUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          messages: [
            {
              role: "user",
              content: buildDecomposePrompt(category, content),
            },
          ],
        }),
      });

      if (!llmResponse.ok) {
        const errText = await llmResponse.text();
        console.error("Decompose LLM error:", llmResponse.status, errText);
        return c.json(
          { error: `LLM request failed: ${llmResponse.status}` },
          502,
        );
      }

      const result = (await llmResponse.json()) as Record<string, unknown>;
      const subGraph = parseDecomposeResponse(result);

      if ("error" in subGraph) {
        return c.json(subGraph, 500);
      }

      // Attach source node info
      subGraph.sourceNode = {
        label: category.replace(/_/g, " "),
        category,
        tokens: content.length, // rough estimate
      };

      return c.json(subGraph);
    } catch (err) {
      console.error("Decompose error:", err);
      return c.json({ error: `Decompose request failed: ${err}` }, 500);
    }
  });

  // --- Conversations ---

  app.delete("/api/conversations/:id", (c) => {
    const convoId = decodeURIComponent(c.req.param("id"));
    store.deleteConversation(convoId);
    return c.json({ ok: true });
  });

  app.get("/api/conversations/:id", (c) => {
    const convoId = decodeURIComponent(c.req.param("id"));
    const { grouped } = buildConversationGroups(store);
    const conversations = store.getConversations();
    const entries = grouped.get(convoId);

    if (!entries || entries.length === 0) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return c.json(
      buildFullConversation(convoId, entries, conversations, store),
    );
  });

  // --- Reset ---

  app.post("/api/reset", (c) => {
    store.resetAll();
    return c.json({ ok: true });
  });

  // --- Tags ---

  app.get("/api/tags", (c) => {
    const allTags = store.getAllTags();
    const tags = [...allTags.entries()].map(([name, count]) => ({
      name,
      count,
    }));
    tags.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ tags });
  });

  app.patch("/api/sessions/:id/tags", async (c) => {
    const convoId = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json();

    if (!Array.isArray(body.tags)) {
      return c.json({ error: "tags must be an array" }, 400);
    }

    try {
      store.setTags(convoId, body.tags);
      return c.json({ ok: true, tags: store.getTags(convoId) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 404);
    }
  });

  app.post("/api/sessions/:id/tags", async (c) => {
    const convoId = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json();

    if (typeof body.tag !== "string" || !body.tag.trim()) {
      return c.json({ error: "tag must be a non-empty string" }, 400);
    }

    try {
      store.addTag(convoId, body.tag);
      return c.json({ ok: true, tags: store.getTags(convoId) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 404);
    }
  });

  app.delete("/api/sessions/:id/tags/:tag", (c) => {
    const convoId = decodeURIComponent(c.req.param("id"));
    const tag = decodeURIComponent(c.req.param("tag"));

    try {
      store.removeTag(convoId, tag);
      return c.json({ ok: true, tags: store.getTags(convoId) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 404);
    }
  });

  // --- Requests (summary + full) ---

  app.get("/api/requests", (c) => {
    const isSummary = c.req.query("summary") === "true";
    const { grouped, ungrouped } = buildConversationGroups(store);
    const conversations = store.getConversations();

    if (isSummary) {
      const summaries = [];
      for (const [id, rawEntries] of grouped) {
        // Sort newest-first for consistent access patterns
        const entries = [...rawEntries].sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );
        const meta = conversations.get(id) || {
          id,
          label: "Unknown",
          source: "unknown",
          workingDirectory: null,
          firstSeen: entries[entries.length - 1].timestamp,
        };
        const latest = entries[0];
        const totalCost = entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);

        const keyCounts = new Map<string, number>();
        for (const e of entries) {
          const k = e.agentKey || "_default";
          keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
        }
        let mainKey = "_default";
        let maxCount = 0;
        for (const [k, count] of keyCounts) {
          if (count > maxCount) {
            mainKey = k;
            maxCount = count;
          }
        }
        const tokenHistory: number[] = [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const k = entries[i].agentKey || "_default";
          if (k === mainKey) {
            tokenHistory.push(entries[i].contextInfo.totalTokens);
          }
        }

        // Get tags for this conversation
        const tags = store.getTags(id);

        summaries.push({
          ...meta,
          entryCount: entries.length,
          latestTimestamp: latest.timestamp,
          latestModel: latest.contextInfo.model,
          latestTotalTokens: latest.contextInfo.totalTokens,
          contextLimit: latest.contextLimit,
          totalCost,
          healthScore: latest.healthScore,
          tokenHistory,
          tags,
        });
      }
      summaries.sort(
        (a, b) =>
          new Date(b.latestTimestamp).getTime() -
          new Date(a.latestTimestamp).getTime(),
      );
      return c.json({
        revision: store.getRevision(),
        conversations: summaries,
        ungroupedCount: ungrouped.length,
      });
    }

    // Full response
    const convos: ConversationGroup[] = [];
    for (const [id, entries] of grouped) {
      convos.push(buildFullConversation(id, entries, conversations, store));
    }
    convos.sort(
      (a, b) =>
        new Date(b.entries[0].timestamp).getTime() -
        new Date(a.entries[0].timestamp).getTime(),
    );
    return c.json({
      revision: store.getRevision(),
      conversations: convos,
      ungrouped: ungrouped.map(projectEntryForApi),
    });
  });

  // --- SSE events ---

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const initial = JSON.stringify({
        revision: store.getRevision(),
        type: "connected",
      });
      await stream.writeSSE({ data: initial });

      const listener = (event: {
        type: string;
        revision: number;
        conversationId?: string | null;
      }) => {
        const data = JSON.stringify(event);
        stream.writeSSE({ data }).catch(() => {
          // Client disconnected
        });
      };

      store.on("change", listener);
      stream.onAbort(() => {
        store.off("change", listener);
      });

      // Keep the stream open until the client disconnects
      await new Promise(() => {});
    });
  });

  // --- Proxy Config (API 轮盘) ---

  /** Mask API key for frontend display: show first 6 + last 2 chars */
  function maskApiKey(key: string): string {
    if (key.length <= 10) return "***";
    return `${key.slice(0, 6)}...${key.slice(-2)}`;
  }

  app.get("/api/config/proxy", (c) => {
    const config = readProxyConfigFile();
    if (!config) {
      // Return default empty config
      // No JSON config file — build defaults from environment variables
      const envDefaults: ProxyConfigFile = {
        providers: {
          anthropic: {
            endpoints: [
              {
                url:
                  process.env.UPSTREAM_ANTHROPIC_URL ||
                  "https://api.anthropic.com",
                apiKey: process.env.ANTHROPIC_API_KEY || "",
                weight: 100,
                enabled: true,
              },
            ],
            strategy: "failover",
          },
          openai: {
            endpoints: [
              {
                url:
                  process.env.UPSTREAM_OPENAI_URL || "https://api.openai.com",
                apiKey: process.env.OPENAI_API_KEY || "",
                weight: 100,
                enabled: true,
              },
            ],
            strategy: "failover",
          },
          gemini: {
            endpoints: [
              {
                url:
                  process.env.UPSTREAM_GEMINI_URL ||
                  "https://generativelanguage.googleapis.com",
                apiKey: process.env.GEMINI_API_KEY || "",
                weight: 100,
                enabled: true,
              },
            ],
            strategy: "failover",
          },
        },
        updatedAt: "(from env)",
      };
      // Mask keys
      for (const p of Object.values(envDefaults.providers)) {
        for (const ep of p.endpoints) {
          ep.apiKey = ep.apiKey ? maskApiKey(ep.apiKey) : "";
        }
      }
      return c.json(envDefaults);
    }
    // Mask API keys before sending to frontend
    const masked: ProxyConfigFile = {
      ...config,
      providers: Object.fromEntries(
        Object.entries(config.providers).map(([name, provider]) => [
          name,
          {
            ...provider,
            endpoints: provider.endpoints.map((ep) => ({
              ...ep,
              apiKey: maskApiKey(ep.apiKey),
            })),
          },
        ]),
      ),
    };
    return c.json(masked);
  });

  app.post("/api/config/proxy", async (c) => {
    const body = (await c.req.json()) as ProxyConfigFile;
    if (!body.providers) {
      return c.json({ error: "providers is required" }, 400);
    }

    // If frontend sends masked keys, merge with existing real keys
    const existing = readProxyConfigFile();
    if (existing) {
      for (const [name, provider] of Object.entries(body.providers)) {
        const existingProvider = existing.providers[name];
        if (!existingProvider) continue;
        for (let i = 0; i < provider.endpoints.length; i++) {
          const ep = provider.endpoints[i];
          if (ep.apiKey.includes("...") && existingProvider.endpoints[i]) {
            ep.apiKey = existingProvider.endpoints[i].apiKey;
          }
        }
      }
    }

    body.updatedAt = new Date().toISOString();

    try {
      if (!existsSync(PROXY_CONFIG_DIR)) {
        mkdirSync(PROXY_CONFIG_DIR, { recursive: true });
      }
      writeFileSync(PROXY_CONFIG_PATH, JSON.stringify(body, null, 2), "utf-8");
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to write config: ${msg}` }, 500);
    }
  });

  app.post("/api/config/proxy/restart", (c) => {
    try {
      // Find proxy process by port (default 4040)
      const pidOutput = execSync("lsof -ti :4040 2>/dev/null || true")
        .toString()
        .trim();
      if (pidOutput) {
        const pids = pidOutput.split("\n").filter(Boolean);
        for (const pid of pids) {
          try {
            process.kill(parseInt(pid, 10), "SIGHUP");
          } catch {
            // Process may have already exited
          }
        }
        return c.json({
          ok: true,
          message: `Sent SIGHUP to PIDs: ${pids.join(", ")}`,
        });
      }
      return c.json({
        ok: true,
        message: "No proxy process found on port 4040",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Restart failed: ${msg}` }, 500);
    }
  });

  app.get("/api/config/proxy/status", (c) => {
    try {
      const pidOutput = execSync("lsof -ti :4040 2>/dev/null || true")
        .toString()
        .trim();
      if (pidOutput) {
        const pids = pidOutput.split("\n").filter(Boolean);
        return c.json({ running: true, pid: parseInt(pids[0], 10) });
      }
      return c.json({ running: false });
    } catch {
      return c.json({ running: false });
    }
  });

  // --- OpenClaw Models Config ---

  const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

  function readOpenClawConfig(): Record<string, unknown> | null {
    try {
      if (existsSync(OPENCLAW_CONFIG_PATH)) {
        return JSON.parse(
          readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"),
        ) as Record<string, unknown>;
      }
    } catch (e) {
      console.warn("Failed to read openclaw.json:", e);
    }
    return null;
  }

  app.get("/api/config/models", (c) => {
    const config = readOpenClawConfig();
    if (!config) {
      return c.json({ providers: {}, primary: "", compaction: "safeguard" });
    }
    const models = config.models as Record<string, unknown> | undefined;
    const agents = config.agents as Record<string, unknown> | undefined;
    const defaults = (agents?.defaults ?? {}) as Record<string, unknown>;
    const modelConfig = (defaults.model ?? {}) as Record<string, unknown>;
    const compactionConfig = (defaults.compaction ?? {}) as Record<
      string,
      unknown
    >;

    // Mask API keys in providers
    const providers =
      ((models?.providers ?? {}) as Record<string, Record<string, unknown>>) ||
      {};
    const maskedProviders: Record<string, unknown> = {};
    for (const [name, provider] of Object.entries(providers)) {
      const key = (provider.apiKey as string) || "";
      maskedProviders[name] = {
        ...provider,
        apiKey:
          key.length > 10
            ? `${key.slice(0, 6)}...${key.slice(-2)}`
            : key
              ? "***"
              : "",
      };
    }

    return c.json({
      providers: maskedProviders,
      primary: modelConfig.primary || "",
      compaction: compactionConfig.mode || "safeguard",
    });
  });

  app.post("/api/config/models", async (c) => {
    const body = await c.req.json();
    const config = readOpenClawConfig() || {};

    // Merge providers — preserve real API keys if masked
    const existingModels = (config.models ?? {}) as Record<string, unknown>;
    const existingProviders =
      ((existingModels.providers ?? {}) as Record<
        string,
        Record<string, unknown>
      >) || {};

    const newProviders = (body.providers ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [name, provider] of Object.entries(newProviders)) {
      const key = (provider.apiKey as string) || "";
      if (key.includes("...") && existingProviders[name]) {
        provider.apiKey = existingProviders[name].apiKey;
      }
    }

    // Update config
    if (!config.models) config.models = {};
    (config.models as Record<string, unknown>).providers = newProviders;
    (config.models as Record<string, unknown>).mode =
      existingModels.mode || "merge";

    // Update primary model
    if (body.primary !== undefined) {
      if (!config.agents) config.agents = {};
      const agents = config.agents as Record<string, unknown>;
      if (!agents.defaults) agents.defaults = {};
      const defaults = agents.defaults as Record<string, unknown>;
      if (!defaults.model) defaults.model = {};
      (defaults.model as Record<string, unknown>).primary = body.primary;
    }

    // Update compaction
    if (body.compaction !== undefined) {
      if (!config.agents) config.agents = {};
      const agents = config.agents as Record<string, unknown>;
      if (!agents.defaults) agents.defaults = {};
      const defaults = agents.defaults as Record<string, unknown>;
      if (!defaults.compaction) defaults.compaction = {};
      (defaults.compaction as Record<string, unknown>).mode = body.compaction;
    }

    // Update meta
    if (!config.meta) config.meta = {};
    (config.meta as Record<string, unknown>).lastTouchedAt =
      new Date().toISOString();

    try {
      writeFileSync(
        OPENCLAW_CONFIG_PATH,
        JSON.stringify(config, null, 4),
        "utf-8",
      );
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to write openclaw.json: ${msg}` }, 500);
    }
  });

  app.post("/api/config/models/list", async (c) => {
    const { baseUrl, apiKey, api } = await c.req.json();
    if (!baseUrl) return c.json({ error: "baseUrl required" }, 400);

    try {
      let models: { id: string; name: string }[] = [];

      if (api === "anthropic-messages" || api === "anthropic") {
        // Anthropic: no standard list endpoint, return known models
        models = [
          { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
          { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
          { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
          { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
          { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
        ];
      } else {
        // OpenAI-compatible: GET /v1/models
        const url = baseUrl.replace(/\/$/, "");
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey && !apiKey.includes("...")) {
          headers.Authorization = `Bearer ${apiKey}`;
        }
        const res = await fetch(`${url}/v1/models`, { headers });
        if (res.ok) {
          const data = (await res.json()) as {
            data?: { id: string; name?: string }[];
          };
          models = (data.data || []).map((m) => ({
            id: m.id,
            name: m.name || m.id,
          }));
        } else {
          return c.json({ error: `Failed to list models: ${res.status}` }, 502);
        }
      }

      return c.json({ models });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `List models failed: ${msg}` }, 500);
    }
  });

  // --- Export ---

  app.get("/api/export/lhar", (c) => {
    const conversation = c.req.query("conversation");
    const privacy = (c.req.query("privacy") || "standard") as PrivacyLevel;
    const entries = getExportEntries(store, conversation);
    const jsonl = toLharJsonl(entries, store.getConversations(), privacy);
    const filename = buildExportFilename("lhar", conversation, privacy);
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    return c.text(jsonl, 200, {
      "Content-Type": "application/x-ndjson",
    });
  });

  app.get("/api/export/lhar.json", (c) => {
    const conversation = c.req.query("conversation");
    const privacy = (c.req.query("privacy") || "standard") as PrivacyLevel;
    const entries = getExportEntries(store, conversation);
    const wrapped = toLharJson(entries, store.getConversations(), privacy);
    const filename = buildExportFilename("lhar.json", conversation, privacy);
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    return c.json(wrapped);
  });

  return app;
}
