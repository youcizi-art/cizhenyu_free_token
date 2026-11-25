import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { homeDir, ensureHome } from "./paths.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const TIER_ORDER = ["free", "trial", "cheap", "paid", "custom"];
export const PROTOCOL_IDS = ["openai", "anthropic", "google-gemini"];

/** 策展 JSON 体积小，每次读取以便热更新安装副本后无需改代码重启逻辑依赖 */
export function loadBuiltinCatalog() {
  const p = join(ROOT, "data", "providers.json");
  if (!existsSync(p)) {
    return { version: 0, providers: [], updatedAt: "", note: "catalog missing" };
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

function customPath() {
  return join(homeDir(), "custom-providers.json");
}

export function loadCustomProviders() {
  ensureHome();
  const p = customPath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const list = Array.isArray(raw?.providers) ? raw.providers : Array.isArray(raw) ? raw : [];
    return list.map(normalizeProvider).filter(Boolean);
  } catch {
    return [];
  }
}

function saveCustomProviders(list) {
  ensureHome();
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(
    customPath(),
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        providers: list.map(normalizeProvider).filter(Boolean),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

export function normalizeTiers(p) {
  const fromArr = Array.isArray(p?.tiers)
    ? p.tiers.map((t) => String(t || "").trim()).filter(Boolean)
    : [];
  const single = String(p?.tier || "").trim();
  const set = new Set();
  for (const t of fromArr.length ? fromArr : single ? [single] : ["paid"]) {
    if (TIER_ORDER.includes(t)) set.add(t);
  }
  if (!set.size) set.add("paid");
  return TIER_ORDER.filter((t) => set.has(t));
}

export function primaryTier(p) {
  const tiers = normalizeTiers(p);
  return tiers[0] || "paid";
}

export function providerMatchesFilter(p, filter) {
  if (!filter || filter === "all") return true;
  return normalizeTiers(p).includes(filter);
}

function normalizeProtocol(v) {
  const s = String(v || "openai").trim();
  return PROTOCOL_IDS.includes(s) ? s : "openai";
}

export function normalizeProvider(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const tiers = normalizeTiers(raw);
  const models = Array.isArray(raw.models)
    ? raw.models.map((m) => String(m).trim()).filter(Boolean)
    : String(raw.models || "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
  return {
    id,
    name: String(raw.name || id).trim() || id,
    tier: tiers[0],
    tiers,
    protocol: normalizeProtocol(raw.protocol),
    baseUrl: String(raw.baseUrl || "").trim(),
    signupUrl: String(raw.signupUrl || "").trim(),
    docsUrl: String(raw.docsUrl || "").trim(),
    models,
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(String) : undefined,
    modelCapabilities:
      raw.modelCapabilities && typeof raw.modelCapabilities === "object"
        ? raw.modelCapabilities
        : undefined,
    quotaHint: String(raw.quotaHint || raw.guide || "").trim(),
    notes: String(raw.notes || raw.description || "").trim(),
    custom: Boolean(raw.custom),
    defaultPriority:
      Number.isFinite(Number(raw.defaultPriority)) && Number(raw.defaultPriority) > 0
        ? Number(raw.defaultPriority)
        : undefined,
    updatedAt: raw.updatedAt || undefined,
  };
}

function toPublic(p) {
  return {
    id: p.id,
    name: p.name,
    tier: p.tier,
    tiers: p.tiers || normalizeTiers(p),
    protocol: p.protocol || "openai",
    baseUrl: p.baseUrl || "",
    signupUrl: p.signupUrl || "",
    docsUrl: p.docsUrl || "",
    models: p.models || [],
    capabilities: Array.isArray(p.capabilities) ? p.capabilities : undefined,
    modelCapabilities:
      p.modelCapabilities && typeof p.modelCapabilities === "object"
        ? p.modelCapabilities
        : undefined,
    quotaHint: p.quotaHint || "",
    notes: p.notes || "",
    custom: Boolean(p.custom),
    defaultPriority: p.defaultPriority,
  };
}

export function loadCatalog() {
  const builtin = loadBuiltinCatalog();
  const custom = loadCustomProviders();
  const byId = new Map();
  for (const raw of builtin.providers || []) {
    const p = normalizeProvider({ ...raw, custom: false });
    if (p) byId.set(p.id, p);
  }
  // 用户自定义覆盖同 id（避免与内置冲突：自定义 id 带 usr- 前缀）
  for (const p of custom) {
    byId.set(p.id, { ...p, custom: true });
  }
  return {
    version: builtin.version,
    updatedAt: builtin.updatedAt,
    note: builtin.note || "",
    providers: [...byId.values()],
  };
}

export function getProvider(id) {
  const want = String(id || "").trim();
  if (!want) return null;
  return loadCatalog().providers.find((p) => p.id === want) || null;
}

export function publicCatalog() {
  const cat = loadCatalog();
  return {
    version: cat.version,
    updatedAt: cat.updatedAt,
    note: cat.note || "",
    providers: cat.providers.map(toPublic),
  };
}

function genCustomId(name) {
  const slug = String(name || "custom")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `usr-${slug || "custom"}-${randomBytes(3).toString("hex")}`;
}

/**
 * 新增或更新用户自定义商家（写入 home/custom-providers.json，不改安装包目录）。
 * @returns {{ provider: object, created: boolean }}
 */
export function upsertCustomProvider(input) {
  const name = String(input?.name || "").trim();
  if (!name) throw new Error("标题不能为空");
  const tiers = normalizeTiers({
    tiers: Array.isArray(input?.tiers) ? input.tiers : undefined,
    tier: input?.tier,
  });
  if (!tiers.length) throw new Error("请至少选择一个分类");

  const list = loadCustomProviders();
  const editId = String(input?.id || "").trim();
  let existing = editId ? list.find((p) => p.id === editId) : null;
  if (editId && !existing) throw new Error("找不到该自定义商家");

  const id = existing?.id || genCustomId(name);
  const next = normalizeProvider({
    id,
    name,
    tiers,
    tier: tiers[0],
    protocol: input?.protocol,
    baseUrl: input?.baseUrl,
    signupUrl: input?.signupUrl,
    docsUrl: input?.docsUrl,
    models: input?.models,
    notes: input?.notes ?? input?.description,
    quotaHint: input?.quotaHint ?? input?.guide,
    defaultPriority: input?.defaultPriority ?? input?.priority,
    custom: true,
    updatedAt: new Date().toISOString(),
  });
  if (!next) throw new Error("无效的商家数据");

  const out = existing
    ? list.map((p) => (p.id === id ? next : p))
    : [...list, next];
  saveCustomProviders(out);
  return { provider: toPublic(next), created: !existing };
}

export function removeCustomProvider(id) {
  const want = String(id || "").trim();
  if (!want) throw new Error("缺少 id");
  const list = loadCustomProviders();
  const next = list.filter((p) => p.id !== want);
  if (next.length === list.length) throw new Error("找不到该自定义商家");
  saveCustomProviders(next);
  return true;
}
