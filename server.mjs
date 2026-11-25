#!/usr/bin/env node
/**
 * Free Token Gateway
 * - UI：商家目录 / 连接 / 轮换
 * - OpenAI：/v1/*
 * - Anthropic(DSH)：/v1/messages 、 /models
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  loadConfig,
  saveConfig,
  publicConfigView,
  listModelIds,
  effectiveDefaultModel,
  upsertConnection,
  removeConnection,
  genId,
} from "./lib/config.mjs";
import { publicCatalog, getProvider } from "./lib/catalog.mjs";
import {
  proxyChatCompletions,
  proxyChatCompletionsStream,
  proxyImageGenerations,
} from "./lib/proxy.mjs";
import { proxyAnthropicMessages, writeAnthropicSSE } from "./lib/anthropic.mjs";
import { poolStats } from "./lib/route_pool.mjs";
import {
  publicRouteStats,
  resetRouteStats,
  flushRouteStats,
} from "./lib/route_stats.mjs";
import {
  applyOnGatewayUp,
  restoreOnGatewayDown,
  wireStatus,
} from "./lib/agent_wire.mjs";
import { ROOT, ensureHome, portPath, pidPath, defaultPort } from "./lib/paths.mjs";

ensureHome();
writeFileSync(pidPath(), String(process.pid), "utf8");

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(data);
}

function checkLocalAuth(req, cfg) {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const key = m ? m[1].trim() : "";
  if (!key) return false;
  return key === cfg.localApiKey;
}

function checkAnyAuth(req, cfg) {
  if (checkLocalAuth(req, cfg)) return true;
  const x = String(req.headers["x-api-key"] || "").trim();
  return Boolean(x) && x === cfg.localApiKey;
}

function mime(p) {
  switch (extname(p)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function serveStatic(res, rel) {
  const file = join(ROOT, "public", rel);
  if (!existsSync(file) || !file.startsWith(join(ROOT, "public"))) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, { "Content-Type": mime(file) });
  res.end(readFileSync(file));
}

function modelsPayload(cfg) {
  return listModelIds(cfg).map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "cizhenyu-free-token",
    display_name: id,
  }));
}

function tryApplyWire() {
  try {
    return { ok: true, wire: applyOnGatewayUp() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), wire: wireStatus() };
  }
}

async function handle(req, res) {
  const cfg = loadConfig();
  const host = req.headers.host || `127.0.0.1:${cfg.port}`;
  const url = new URL(req.url || "/", `http://${host}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key, anthropic-version",
    });
    res.end();
    return;
  }

  if (path === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "cizhenyu-free-token",
      port: cfg.port,
      connections: (cfg.connections || []).filter((c) => c.enabled !== false).length,
      models: listModelIds(cfg).length,
      wire: wireStatus(),
      pid: process.pid,
    });
    return;
  }

  if (path === "/api/catalog" && req.method === "GET") {
    sendJson(res, 200, publicCatalog());
    return;
  }

  /** WebView 常吞掉 target=_blank；用系统浏览器打开外链 */
  if (path === "/api/open-url" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    const url = String(body.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      sendJson(res, 400, { error: "url must be http(s)" });
      return;
    }
    try {
      if (process.platform === "win32") {
        spawn("cmd", ["/c", "start", "", url], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      } else if (process.platform === "darwin") {
        spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message || e) });
    }
    return;
  }

  if (path === "/api/config" && req.method === "GET") {
    sendJson(res, 200, { ...publicConfigView(cfg), wire: wireStatus() });
    return;
  }

  if (path === "/api/wire" && req.method === "GET") {
    sendJson(res, 200, wireStatus());
    return;
  }

  if (path === "/api/route-status" && req.method === "GET") {
    sendJson(res, 200, {
      ...poolStats(cfg),
      ...publicRouteStats(cfg),
      defaultModel: cfg.defaultModel || "",
      effectiveDefaultModel: effectiveDefaultModel(cfg),
      injectedModels: listModelIds(cfg),
      strategy: cfg.strategy,
    });
    return;
  }

  if (path === "/api/route-stats/reset" && req.method === "POST") {
    resetRouteStats();
    sendJson(res, 200, { ok: true, ...publicRouteStats(cfg) });
    return;
  }

  if (path === "/api/wire/apply" && req.method === "POST") {
    sendJson(res, 200, tryApplyWire());
    return;
  }

  if (path === "/api/wire/restore" && req.method === "POST") {
    sendJson(res, 200, { ok: true, wire: restoreOnGatewayDown() });
    return;
  }

  if (path === "/api/config" && req.method === "PUT") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    const next = { ...cfg };
    if (body.port != null) {
      const p = Number(body.port);
      if (Number.isFinite(p) && p > 0) next.port = p;
    }
    if (typeof body.defaultModel === "string") next.defaultModel = body.defaultModel.trim();
    if (body.strategy && typeof body.strategy === "object") {
      next.strategy = { ...next.strategy, ...body.strategy };
    }
    if (body.rotateLocalKey === true) {
      next.localApiKey = `sk-cizhenyu-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    }
    if (Array.isArray(body.connections)) {
      next.connections = body.connections.map((c, i) => {
        const prev = (cfg.connections || []).find((x) => x.id === c.id);
        const apiKey =
          c.apiKey === undefined || c.apiKey === null || c.apiKey === ""
            ? prev?.apiKey || ""
            : String(c.apiKey);
        return { ...c, apiKey };
      });
    }
    const saved = saveConfig(next);
    const wire = tryApplyWire();
    sendJson(res, 200, { ...publicConfigView(saved), wire });
    return;
  }

  if (path === "/api/connections" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    const providerId = String(body.providerId || "custom").trim();
    const prov = getProvider(providerId);
    const editId = String(body.id || "").trim();
    const prev = editId
      ? (cfg.connections || []).find((x) => x.id === editId)
      : null;
    // 编辑时 apiKey 省略/空串 → 保留原密钥
    const apiKeyRaw = body.apiKey;
    const apiKey =
      apiKeyRaw === undefined || apiKeyRaw === null || String(apiKeyRaw).trim() === ""
        ? prev?.apiKey || ""
        : String(apiKeyRaw).trim();
    if (!apiKey) {
      sendJson(res, 400, { error: "apiKey required" });
      return;
    }
    const saved = upsertConnection(cfg, {
      id: editId || genId("conn"),
      providerId,
      label: body.label || prov?.name || "连接",
      apiKey,
      baseUrl: body.baseUrl || prev?.baseUrl || prov?.baseUrl || "",
      models:
        Array.isArray(body.models) && body.models.length
          ? body.models
          : [...(prev?.models || prov?.models || [])],
      enabled: body.enabled !== false,
      priority: body.priority,
      tier: body.tier || prev?.tier || prov?.tier || "paid",
      capabilities: body.capabilities || prev?.capabilities,
    });
    const wire = tryApplyWire();
    sendJson(res, 200, { ...publicConfigView(saved), wire });
    return;
  }

  if (path.startsWith("/api/connections/") && req.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/api/connections/".length));
    const saved = removeConnection(cfg, id);
    const wire = tryApplyWire();
    sendJson(res, 200, { ...publicConfigView(saved), wire });
    return;
  }

  if (path === "/models" && req.method === "GET") {
    if (!checkAnyAuth(req, cfg)) {
      sendJson(res, 401, { error: { type: "authentication_error", message: "Invalid API key" } });
      return;
    }
    sendJson(res, 200, { data: modelsPayload(cfg) });
    return;
  }

  if (path === "/v1/models" && req.method === "GET") {
    if (!checkAnyAuth(req, cfg)) {
      sendJson(res, 401, { error: { message: "Invalid API key", type: "auth" } });
      return;
    }
    sendJson(res, 200, { object: "list", data: modelsPayload(cfg) });
    return;
  }

  if (path === "/v1/messages" && req.method === "POST") {
    if (!checkAnyAuth(req, cfg)) {
      sendJson(res, 401, {
        type: "error",
        error: { type: "authentication_error", message: "Invalid API key" },
      });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, {
        type: "error",
        error: { type: "invalid_request_error", message: "invalid json" },
      });
      return;
    }
    const result = await proxyAnthropicMessages(loadConfig(), body);
    if (result.status >= 400) {
      sendJson(res, result.status, result.body, result.headers || {});
      return;
    }
    if (body.stream || result.stream) {
      writeAnthropicSSE(res, result.body, result.headers || {});
      return;
    }
    sendJson(res, result.status, result.body, result.headers || {});
    return;
  }

  if (path === "/v1/chat/completions" && req.method === "POST") {
    if (!checkAnyAuth(req, cfg)) {
      sendJson(res, 401, { error: { message: "Invalid API key", type: "auth" } });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: { message: "invalid json" } });
      return;
    }
    const live = loadConfig();
    if (body.stream) {
      await proxyChatCompletionsStream(live, body, res);
      return;
    }
    const result = await proxyChatCompletions(live, body);
    sendJson(res, result.status, result.body, result.headers || {});
    return;
  }

  if (
    (path === "/v1/images/generations" || path === "/images/generations") &&
    req.method === "POST"
  ) {
    if (!checkAnyAuth(req, cfg)) {
      sendJson(res, 401, { error: { message: "Invalid API key", type: "auth" } });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: { message: "invalid json" } });
      return;
    }
    const result = await proxyImageGenerations(loadConfig(), body);
    sendJson(res, result.status, result.body, result.headers || {});
    return;
  }

  if (path === "/" || path === "/index.html") {
    serveStatic(res, "index.html");
    return;
  }
  if (path === "/app.js" || path === "/style.css") {
    serveStatic(res, path.slice(1));
    return;
  }

  sendJson(res, 404, { error: "not found", path });
}

const boot = loadConfig();
const port = Number(process.env.CIZHENYU_FREE_TOKEN_PORT || boot.port || defaultPort());
boot.port = port;
saveConfig(boot);
writeFileSync(portPath(), String(port), "utf8");

createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) sendJson(res, 500, { error: String(e?.message || e) });
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`cizhenyu-free-token http://127.0.0.1:${port}`);
  // 不在启动时自动改写 Agent：避免未就绪/错误模型配置拖死 DSH/OpenCode 开窗。
  // 用户在 UI「保存策略并重新接线」或「重新接线」时再 apply。
  try {
    const w = wireStatus();
    console.log(
      `agent wire ready=${(w.models || []).length > 0} models=${(w.models || []).join(",") || "none"}`,
    );
  } catch (e) {
    console.log(`agent wire status: ${e?.message || e}`);
  }
});

function shutdown() {
  try {
    flushRouteStats();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
