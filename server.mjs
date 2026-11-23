#!/usr/bin/env node
/**
 * Free Token Gateway
 * - UI:  /
 * - OpenAI:  /v1/chat/completions 、 /v1/models
 * - Anthropic(DSH): /v1/messages 、 /models（origin 根路径）
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, saveConfig, publicConfigView, listModelIds } from "./lib/config.mjs";
import { proxyChatCompletions, proxyChatCompletionsStream } from "./lib/proxy.mjs";
import { proxyAnthropicMessages } from "./lib/anthropic.mjs";
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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
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

/** DSH / Anthropic 客户端常用 x-api-key */
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
  const buf = readFileSync(file);
  res.writeHead(200, { "Content-Type": mime(file) });
  res.end(buf);
}

function modelsPayload(cfg) {
  const ids = listModelIds(cfg);
  return ids.map((id) => ({
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
      upstreams: (cfg.upstreams || []).filter((u) => u.enabled !== false).length,
      models: listModelIds(cfg).length,
      wire: wireStatus(),
      pid: process.pid,
    });
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
    if (body.rotateLocalKey === true) {
      next.localApiKey = `sk-cizhenyu-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
    }
    if (Array.isArray(body.upstreams)) {
      next.upstreams = body.upstreams.map((u, i) => {
        const prev = (cfg.upstreams || []).find((x) => x.id === u.id);
        const apiKey =
          u.apiKey === undefined || u.apiKey === null || u.apiKey === ""
            ? prev?.apiKey || ""
            : String(u.apiKey);
        return {
          id: String(u.id || `up-${i + 1}`),
          name: String(u.name || `上游 ${i + 1}`),
          baseUrl: String(u.baseUrl || "").trim(),
          apiKey,
          models: Array.isArray(u.models)
            ? u.models.map((m) => String(m).trim()).filter(Boolean)
            : [],
          enabled: u.enabled !== false,
        };
      });
    }
    const saved = saveConfig(next);
    const wire = tryApplyWire();
    sendJson(res, 200, { ...publicConfigView(saved), wire });
    return;
  }

  if (path === "/api/import-cms-preview" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    const providers = body?.providers || body?.ai_config?.providers || [];
    if (!Array.isArray(providers)) {
      sendJson(res, 400, { error: "providers array required" });
      return;
    }
    const mapped = providers.map((p, i) => {
      const models = Array.isArray(p.models)
        ? p.models.map((m) => (typeof m === "string" ? m : m?.id || m?.name)).filter(Boolean)
        : [];
      return {
        id: String(p.id || `cms-${i + 1}`),
        name: String(p.name || p.type || `CMS ${i + 1}`),
        baseUrl: String(p.baseUrl || "").trim(),
        apiKey: String(p.apiKey || "").trim(),
        models,
        enabled: true,
        source: "cms_ai_config",
      };
    });
    sendJson(res, 200, { upstreams: mapped });
    return;
  }

  // DSH 模型列表：GET {origin}/models
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

  // DSH Anthropic Messages
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
    const result = await proxyAnthropicMessages(cfg, body);
    sendJson(res, result.status, result.body);
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
    if (body.stream) {
      await proxyChatCompletionsStream(cfg, body, res);
      return;
    }
    const result = await proxyChatCompletions(cfg, body);
    sendJson(res, result.status, result.body);
    return;
  }

  if (path === "/" || path === "/index.html") {
    serveStatic(res, "index.html");
    return;
  }
  if (path === "/app.js" || path === "/style.css") {
    serveStatic(res, path.replace(/^\//, ""));
    return;
  }

  sendJson(res, 404, { error: "not found", path });
}

const boot = loadConfig();
const port = Number(process.env.CIZHENYU_FREE_TOKEN_PORT || boot.port || defaultPort());
boot.port = port;
saveConfig(boot);
writeFileSync(portPath(), String(port), "utf8");

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: String(e?.message || e) });
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`cizhenyu-free-token http://127.0.0.1:${port}`);
  console.log(`  UI        http://127.0.0.1:${port}/`);
  console.log(`  OpenAI    http://127.0.0.1:${port}/v1`);
  console.log(`  Anthropic http://127.0.0.1:${port}/v1/messages`);
  try {
    const w = applyOnGatewayUp();
    console.log(`  agent wire active=${w.active} model=${w.defaultModel || ""}`);
  } catch (e) {
    console.log(`  agent wire skipped: ${e?.message || e}`);
  }
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
