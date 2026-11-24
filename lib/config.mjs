import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { configPath, defaultPort, ensureHome } from "./paths.mjs";
import { getProvider } from "./catalog.mjs";

/** 与 route_pool 保持同名，避免 config↔route_pool 循环依赖 */
export const LOGICAL_AUTO_TEXT = "cizhenyu/auto-text";
export const LOGICAL_AUTO_VISION = "cizhenyu/auto-vision";

const VISION_HINT =
  /pixtral|vision|gpt-4o|gpt-4\.1|llama-4-scout|omni|vl\b|gemini-2|gemma-3|flash-lite|flash\b/i;

export function inferCapabilities(providerId, models) {
  const prov = getProvider(providerId);
  if (Array.isArray(prov?.capabilities) && prov.capabilities.length) {
    return [...new Set(prov.capabilities.map(String))];
  }
  const caps = new Set(["text"]);
  for (const m of models || []) {
    if (VISION_HINT.test(String(m))) caps.add("image");
  }
  return [...caps];
}

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
      modelCooldownSeconds: 300,
      maxAttemptsPerRequest: 5,
      remapOnModelError: true,
      /** 接线时是否把物理模型 id 也注入 Agent（默认否，只注入 auto-text） */
      injectPhysicalModels: false,
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
  const capabilities =
    Array.isArray(c.capabilities) && c.capabilities.length
      ? [...new Set(c.capabilities.map(String))]
      : inferCapabilities(providerId, models);
  const modelCooldowns =
    c.modelCooldowns && typeof c.modelCooldowns === "object" ? { ...c.modelCooldowns } : {};
  return {
    id: String(c.id || genId("conn")),
    providerId,
    label: String(c.label || prov?.name || `连接 ${i + 1}`),
    apiKey: String(c.apiKey || ""),
    baseUrl,
    models,
    capabilities,
    enabled: c.enabled !== false,
    priority: Number.isFinite(Number(c.priority)) ? Number(c.priority) : (i + 1) * 10,
    tier: String(c.tier || prov?.tier || "paid"),
    cooldownUntil: Number(c.cooldownUntil) > 0 ? Number(c.cooldownUntil) : 0,
    modelCooldowns,
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
  const now = Date.now();
  const modelCooldowns = c.modelCooldowns || {};
  const coolingModels = Object.entries(modelCooldowns)
    .filter(([, until]) => Number(until) > now)
    .map(([id, until]) => ({ id, until: Number(until) }));
  return {
    id: c.id,
    providerId: c.providerId,
    label: c.label,
    baseUrl: c.baseUrl,
    models: c.models || [],
    capabilities: c.capabilities || [],
    enabled: c.enabled !== false,
    priority: c.priority,
    tier: c.tier,
    hasApiKey: Boolean(String(c.apiKey || "").trim()),
    cooldownUntil: c.cooldownUntil || 0,
    cooling: Number(c.cooldownUntil || 0) > now,
    coolingModels,
  };
}

export function publicConfigView(cfg) {
  const injectedModels = listModelIds(cfg);
  return {
    version: cfg.version,
    port: cfg.port,
    localApiKey: cfg.localApiKey,
    defaultModel: cfg.defaultModel || "",
    effectiveDefaultModel: effectiveDefaultModel(cfg),
    injectedModels,
    strategy: cfg.strategy,
    updatedAt: cfg.updatedAt,
    connections: (cfg.connections || []).map(publicConnectionView),
  };
}

function connectionReady(c) {
  return (
    c &&
    c.enabled !== false &&
    String(c.apiKey || "").trim() &&
    String(c.baseUrl || "").trim() &&
    Array.isArray(c.models) &&
    c.models.length > 0
  );
}

/** Agent 接线用的模型列表：逻辑 auto-* 优先；物理模型受 strategy.injectPhysicalModels 控制 */
export function listModelIds(cfg) {
  const out = [];
  let hasText = false;
  let hasVision = false;
  for (const c of cfg.connections || []) {
    if (!connectionReady(c)) continue;
    const caps = c.capabilities?.length
      ? c.capabilities
      : inferCapabilities(c.providerId, c.models);
    if (caps.includes("text") || caps.includes("image")) hasText = true;
    if (caps.includes("image")) hasVision = true;
  }
  if (hasText) out.push(LOGICAL_AUTO_TEXT);
  if (hasVision) out.push(LOGICAL_AUTO_VISION);

  if (Boolean(cfg.strategy?.injectPhysicalModels)) {
    for (const c of cfg.connections || []) {
      if (!connectionReady(c)) continue;
      for (const m of c.models || []) {
        const id = String(m || "").trim();
        if (id && !out.includes(id)) out.push(id);
      }
    }
  }

  const def = String(cfg.defaultModel || "").trim();
  if (def && !out.includes(def)) out.unshift(def);
  return out;
}

export function effectiveDefaultModel(cfg) {
  const def = String(cfg.defaultModel || "").trim();
  if (def) return def;
  const models = listModelIds(cfg);
  if (models.includes(LOGICAL_AUTO_TEXT)) return LOGICAL_AUTO_TEXT;
  return models[0] || "";
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
