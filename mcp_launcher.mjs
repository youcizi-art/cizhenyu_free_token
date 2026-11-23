#!/usr/bin/env node
/**
 * 轻量 MCP：查询网关健康 / 模型列表 / 接入说明。
 * 聊天仍走 Agent 的 OpenAI baseURL → 本网关 /v1。
 */
import { createInterface } from "node:readline";
import { loadConfig, listModelIds, publicConfigView } from "./lib/config.mjs";
import { defaultPort } from "./lib/paths.mjs";

async function fetchHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function toolResult(id, text) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
    },
  };
}

const tools = [
  {
    name: "free_token_status",
    description: "Check whether the CIZHENYU Free Token local gateway is running and list endpoint info.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "free_token_models",
    description: "List model ids configured on the Free Token gateway (from upstreams).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "free_token_howto",
    description: "Explain how Agents should point baseURL to this gateway when the service is running.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cizhenyu-free-token", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const cfg = loadConfig();
    const port = cfg.port || defaultPort();
    if (name === "free_token_status") {
      const h = await fetchHealth(port);
      const view = publicConfigView(cfg);
      send(
        toolResult(
          id,
          JSON.stringify(
            {
              running: Boolean(h?.ok),
              port,
              ui: `http://127.0.0.1:${port}/`,
              v1: `http://127.0.0.1:${port}/v1`,
              localApiKeyHint: view.localApiKey ? `${view.localApiKey.slice(0, 12)}…` : "",
              upstreams: view.upstreams?.length || 0,
              health: h,
            },
            null,
            2,
          ),
        ),
      );
      return;
    }
    if (name === "free_token_models") {
      send(toolResult(id, JSON.stringify({ models: listModelIds(cfg), defaultModel: cfg.defaultModel }, null, 2)));
      return;
    }
    if (name === "free_token_howto") {
      send(
        toolResult(
          id,
          [
            "1. In Deploy Ops → Tools, start Free Token Gateway service.",
            "2. Open UI http://127.0.0.1:<port>/ and add upstream API keys.",
            "3. Deploy temporarily points DSH/OpenCode baseURL to http://127.0.0.1:<port>/v1 with the local API key.",
            "4. Stop the service to restore original Agent model settings; gateway home keeps upstream keys.",
            `Current port: ${port}`,
          ].join("\n"),
        ),
      );
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    });
    return;
  }
  if (id != null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
