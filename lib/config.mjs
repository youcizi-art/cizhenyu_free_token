import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { configPath, defaultPort, ensureHome } from "./paths.mjs";
import { getProvider } from "./catalog.mjs";

/** 与 route_pool 保持同名，避免 config↔route_pool 循环依赖 */
export const LOGICAL_AUTO = "cizhenyu/auto";
export const LOGICAL_AUTO_TEXT = "cizhenyu/auto-text";
export const LOGICAL_AUTO_VISION = "cizhenyu/auto-vision";

/**
 * 模型 id 启发式：仅用于「单模型」是否带视觉。
 * 勿用过宽的 flash\b——否则纯文本 flash 也会进视觉池。
 */
const VISION_MODEL_HINT =
  /pixtral|vision|\bvl\b|-vl-|\/vl[.-]|omni|gpt-4o|gpt-4\.1|llama-4-scout|gemini-2|gemma-3|glm-4v|qwen2\.5-vl|qwen2-vl|nemotron.*vl|llava|moondream|idefics/i;

/** 整家商家默认可视觉（目录里所有列出的模型都能看图） */
const PROVIDER_ALL_VISION = new Set(["google-ai-studio"]);

export function modelHasCapability(modelId, capability, providerId = "") {
  const mid = String(modelId || "").trim();
  if (!mid) return false;
  if (capability === "text") return true;
  if (capability === "image") {
    const prov = getProvider(providerId);
    const override = prov?.modelCapabilities?.[mid];
    if (Array.isArray(override)) return override.map(String).includes("image");
    if (PROVIDER_ALL_VISION.has(String(providerId || ""))) return true;
    if (Array.isArray(prov?.capabilities) && prov.capabilities.includes("image")) {
      // 商家标了 image，但仍按模型启发式过滤，避免「一家有一个 VL、整池全塞」
      // 例外：PROVIDER_ALL_VISION 已在上面放行
    }
    return VISION_MODEL_HINT.test(mid);
  }
  if (capability === "video") {
    const prov = getProvider(providerId);
    const override = prov?.modelCapabilities?.[mid];
    if (Array.isArray(override)) return override.map(String).includes("video");
    return /video|veo|sora|kling/i.test(mid);
  }
  if (capability === "image_gen") {
    const prov = getProvider(providerId);
    const override = prov?.modelCapabilities?.[mid];
    if (Array.isArray(override)) return override.map(String).includes("image_gen");
    if (Array.isArray(prov?.capabilities) && prov.capabilities.includes("image_gen")) {
      return true;
    }
    return /dall-e|imagen|flux|stable-diffusion|image-gen|gpt-image/i.test(mid);
  }
  return false;
}

/** 连接级能力 = 商家声明 ∪ 各模型启发式（用于是否注入 auto-vision） */
export function inferCapabilities(providerId, models) {
  const prov = getProvider(providerId);
  const caps = new Set(["text"]);
  if (Array.isArray(prov?.capabilities)) {
    for (const c of prov.capabilities) caps.add(String(c));
  }
  if (PROVIDER_ALL_VISION.has(String(providerId || ""))) caps.add("image");
  for (const m of models || []) {
    if (modelHasCapability(m, "image", providerId)) caps.add("image");
    if (modelHasCapability(m, "video", providerId)) caps.add("video");
    if (modelHasCapability(m, "image_gen", providerId)) caps.add("image_gen");
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
      /** P2：同 tier 内略偏好历史成功率更高的 (连接,模型) */
      preferReliable: true,
      /** 接线时是否把物理模型 id 也注入 Agent（默认否，只注入 auto / auto-text / auto-vision） */
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
  // P3：有任一文本/视觉上游时注入 auto（按请求分流）
  if (hasText || hasVision) out.push(LOGICAL_AUTO);
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
  let def = String(cfg.defaultModel || "").trim();
  const models = listModelIds(cfg);
  // P3：旧默认 auto-text 升为 auto（仍保留列表中的 auto-text 供钉死）
  if (def === LOGICAL_AUTO_TEXT && models.includes(LOGICAL_AUTO)) def = LOGICAL_AUTO;
  if (def) return def;
  if (models.includes(LOGICAL_AUTO)) return LOGICAL_AUTO;
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
