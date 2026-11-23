#!/usr/bin/env node
/**
 * CIZHENYU Free Token Gateway
 * - UI:  http://127.0.0.1:<port>/
 * - API: http://127.0.0.1:<port>/v1/*  (OpenAI compatible)
 * - Admin JSON under /api/*
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, saveConfig, publicConfigView, listModelIds } from "./lib/config.mjs";
import { proxyChatCompletions, proxyChatCompletionsStream } from "./lib/proxy.mjs";
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
  // UI 同源 /api 可无 key；/v1 必须带 localApiKey
  if (!key) return false;
  return key === cfg.localApiKey;
}

function mime(p) {
  switch (extname(p)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
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

async function handle(req, res) {
  const cfg = loadConfig();
  const host = req.headers.host || `127.0.0.1:${cfg.port}`;
  const url = new URL(req.url || "/", `http://${host}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
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
      pid: process.pid,
    });
    return;
  }

  // —— Admin API（本机 UI；无 Bearer 也可读写本机配置，仅绑定 127.0.0.1）——
  if (path === "/api/config" && req.method === "GET") {
    sendJson(res, 200, publicConfigView(cfg));
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
          name: String(u.name || `Upstream ${i + 1}`),
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
    sendJson(res, 200, publicConfigView(saved));
    return;
  }

  if (path === "/api/import-cms-preview" && req.method === "POST") {
    // 仅接受客户端已拉取的 ai_config JSON，不在工具内嵌 CMS 登录
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

  // —— OpenAI compatible ——
  if (path === "/v1/models" && req.method === "GET") {
    if (!checkLocalAuth(req, cfg)) {
      sendJson(res, 401, { error: { message: "Invalid API key", type: "auth" } });
      return;
    }
    const data = listModelIds(cfg).map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "cizhenyu-free-token",
    }));
    if (!data.length) {
      data.push({
        id: cfg.defaultModel || "free-token/default",
        object: "model",
        created: 0,
        owned_by: "cizhenyu-free-token",
      });
    }
    sendJson(res, 200, { object: "list", data });
    return;
  }

  if (path === "/v1/chat/completions" && req.method === "POST") {
    if (!checkLocalAuth(req, cfg)) {
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
  if (path.startsWith("/assets/") || path === "/app.js" || path === "/style.css") {
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
  console.log(`cizhenyu-free-token listening on http://127.0.0.1:${port}`);
  console.log(`UI  http://127.0.0.1:${port}/`);
  console.log(`API http://127.0.0.1:${port}/v1`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
