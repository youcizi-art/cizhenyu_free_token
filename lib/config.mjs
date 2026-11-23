import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { configPath, defaultPort, ensureHome } from "./paths.mjs";

function genLocalKey() {
  return `sk-cizhenyu-${randomBytes(16).toString("hex")}`;
}

export function defaultConfig() {
  return {
    version: 1,
    port: defaultPort(),
    localApiKey: genLocalKey(),
    defaultModel: "",
    /** @type {Array<{id:string,name:string,baseUrl:string,apiKey:string,models:string[],enabled:boolean}>} */
    upstreams: [],
    updatedAt: new Date().toISOString(),
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
    return {
      ...base,
      ...raw,
      localApiKey: String(raw.localApiKey || base.localApiKey),
      port: Number(raw.port) > 0 ? Number(raw.port) : base.port,
      upstreams: Array.isArray(raw.upstreams) ? raw.upstreams : [],
    };
  } catch {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
}

export function saveConfig(cfg) {
  ensureHome();
  const next = {
    ...cfg,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function publicConfigView(cfg) {
  return {
    version: cfg.version,
    port: cfg.port,
    localApiKey: cfg.localApiKey,
    defaultModel: cfg.defaultModel || "",
    updatedAt: cfg.updatedAt,
    upstreams: (cfg.upstreams || []).map((u) => ({
      id: u.id,
      name: u.name,
      baseUrl: u.baseUrl,
      models: u.models || [],
      enabled: u.enabled !== false,
      hasApiKey: Boolean(String(u.apiKey || "").trim()),
    })),
  };
}

export function listModelIds(cfg) {
  const out = [];
  for (const u of cfg.upstreams || []) {
    if (u.enabled === false) continue;
    for (const m of u.models || []) {
      const id = String(m || "").trim();
      if (id && !out.includes(id)) out.push(id);
    }
  }
  if (cfg.defaultModel && !out.includes(cfg.defaultModel)) {
    out.unshift(cfg.defaultModel);
  }
  return out;
}
