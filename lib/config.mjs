import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { configPath, defaultPort, ensureHome } from "./paths.mjs";
import { getProvider } from "./catalog.mjs";

function genLocalKey() {
  return `sk-cizhenyu-${randomBytes(16).toString("hex")}`;
}

function genId(prefix) {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export function defaultConfig() {
  return {
    version: 2,
    port: defaultPort(),
    localApiKey: genLocalKey(),
    defaultModel: "",
    strategy: {
      /** priority：按 priority 升序；round_robin：可用连接轮询 */
      mode: "priority",
      preferFree: true,
      cooldownSeconds: 120,
    },
    /** @type {Array<object>} */
    connections: [],
    updatedAt: new Date().toISOString(),
  };
}

/** 旧版 upstreams → connections（只迁移一次逻辑，读入时规范化） */
function migrateFromUpstreams(raw) {
  if (Array.isArray(raw.connections) && raw.connections.length) {
    return raw.connections;
  }
  const ups = Array.isArray(raw.upstreams) ? raw.upstreams : [];
  return ups.map((u, i) => ({
    id: String(u.id || genId("conn")),
    providerId: "custom",
    label: String(u.name || `上游 ${i + 1}`),
    apiKey: String(u.apiKey || ""),
    baseUrl: String(u.baseUrl || "").trim(),
    models: Array.isArray(u.models) ? u.models.map(String) : [],
    enabled: u.enabled !== false,
    priority: (i + 1) * 10,
    tier: "paid",
    cooldownUntil: 0,
  }));
}

function normalizeConnection(c, i = 0) {
  const providerId = String(c.providerId || "custom").trim() || "custom";
  const prov = getProvider(providerId);
  const baseUrl = String(c.baseUrl || prov?.baseUrl || "").trim();
  const models =
    Array.isArray(c.models) && c.models.length
      ? c.models.map((m) => String(m).trim()).filter(Boolean)
      : [...(prov?.models || [])];
  return {
    id: String(c.id || genId("conn")),
    providerId,
    label: String(c.label || prov?.name || `连接 ${i + 1}`),
    apiKey: String(c.apiKey || ""),
    baseUrl,
    models,
    enabled: c.enabled !== false,
    priority: Number.isFinite(Number(c.priority)) ? Number(c.priority) : (i + 1) * 10,
    tier: String(c.tier || prov?.tier || "paid"),
    cooldownUntil: Number(c.cooldownUntil) > 0 ? Number(c.cooldownUntil) : 0,
  };
}

export function loadConfig() {
  ensureHome();
  const p = configPath();
  if (!existsSync(p)) {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const base = defaultConfig();
    const connections = migrateFromUpstreams(raw).map((c, i) => normalizeConnection(c, i));
    return {
      ...base,
      ...raw,
      version: 2,
      localApiKey: String(raw.localApiKey || base.localApiKey),
      port: Number(raw.port) > 0 ? Number(raw.port) : base.port,
      strategy: {
        ...base.strategy,
        ...(raw.strategy && typeof raw.strategy === "object" ? raw.strategy : {}),
      },
      connections,
      // 保留空数组，避免旧字段继续主导
      upstreams: undefined,
    };
  } catch {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
}

export function saveConfig(cfg) {
  ensureHome();
  const connections = (cfg.connections || []).map((c, i) => normalizeConnection(c, i));
  const next = {
    version: 2,
    port: cfg.port,
    localApiKey: cfg.localApiKey,
    defaultModel: cfg.defaultModel || "",
    strategy: cfg.strategy || defaultConfig().strategy,
    connections,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function publicConnectionView(c) {
  return {
    id: c.id,
    providerId: c.providerId,
    label: c.label,
    baseUrl: c.baseUrl,
    models: c.models || [],
    enabled: c.enabled !== false,
    priority: c.priority,
    tier: c.tier,
    hasApiKey: Boolean(String(c.apiKey || "").trim()),
    cooldownUntil: c.cooldownUntil || 0,
    cooling: Number(c.cooldownUntil || 0) > Date.now(),
  };
}

export function publicConfigView(cfg) {
  return {
    version: cfg.version,
    port: cfg.port,
    localApiKey: cfg.localApiKey,
    defaultModel: cfg.defaultModel || "",
    strategy: cfg.strategy,
    updatedAt: cfg.updatedAt,
    connections: (cfg.connections || []).map(publicConnectionView),
  };
}

export function listModelIds(cfg) {
  const out = [];
  for (const c of cfg.connections || []) {
    if (c.enabled === false) continue;
    if (!String(c.apiKey || "").trim()) continue;
    for (const m of c.models || []) {
      const id = String(m || "").trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  if (cfg.defaultModel && !out.includes(cfg.defaultModel)) {
    out.unshift(cfg.defaultModel);
  }
  return out;
}

export function upsertConnection(cfg, patch) {
  const list = [...(cfg.connections || [])];
  const idx = list.findIndex((c) => c.id === patch.id);
  if (idx >= 0) {
    list[idx] = normalizeConnection({ ...list[idx], ...patch }, idx);
  } else {
    list.push(normalizeConnection({ ...patch, id: patch.id || genId("conn") }, list.length));
  }
  return saveConfig({ ...cfg, connections: list });
}

export function removeConnection(cfg, id) {
  const list = (cfg.connections || []).filter((c) => c.id !== id);
  return saveConfig({ ...cfg, connections: list });
}

export { genId, normalizeConnection };
