/**
 * 用户官方 DeepSeek Key（与网关 localApiKey 分离），供接线后仍可选用官方模型。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir, ensureHome } from "./paths.mjs";

export const OFFICIAL_DEEPSEEK_BASE = "https://api.deepseek.com";

/** DSH 默认目录 + 常见 OpenAI 兼容 id */
export const OFFICIAL_DEEPSEEK_MODELS = [
  {
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    inputModalities: ["text", "image"],
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    inputModalities: ["text"],
  },
  // chat/reasoner：兼容旧接线；官方主力已是 flash / v4-pro
  {
    id: "deepseek-chat",
    name: "deepseek-chat（兼容）",
    inputModalities: ["text"],
  },
  {
    id: "deepseek-reasoner",
    name: "deepseek-reasoner（兼容）",
    inputModalities: ["text"],
  },
];

const OFFICIAL_IDS = new Set(OFFICIAL_DEEPSEEK_MODELS.map((m) => m.id));

export function isGatewayLocalKey(key) {
  return String(key || "")
    .trim()
    .startsWith("sk-cizhenyu-");
}

export function isOfficialDeepseekModel(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return false;
  if (OFFICIAL_IDS.has(id)) return true;
  // 其它 deepseek-* 官方风格 id（排除我们的逻辑模型）
  return /^deepseek-/i.test(id) && !id.startsWith("cizhenyu/");
}

function storePath() {
  return join(homeDir(), "official-deepseek.json");
}

export function loadOfficialDeepseek() {
  ensureHome();
  const p = storePath();
  if (!existsSync(p)) return { apiKey: "", baseUrl: OFFICIAL_DEEPSEEK_BASE };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const apiKey = String(raw.apiKey || "").trim();
    if (isGatewayLocalKey(apiKey)) {
      return { apiKey: "", baseUrl: OFFICIAL_DEEPSEEK_BASE };
    }
    return {
      apiKey,
      baseUrl: String(raw.baseUrl || OFFICIAL_DEEPSEEK_BASE).trim() || OFFICIAL_DEEPSEEK_BASE,
      savedAt: raw.savedAt || "",
    };
  } catch {
    return { apiKey: "", baseUrl: OFFICIAL_DEEPSEEK_BASE };
  }
}

/** 仅当 key 像真实官方 Key 时写入；绝不把网关 Key 存进去 */
export function saveOfficialDeepseek(apiKey, baseUrl = OFFICIAL_DEEPSEEK_BASE) {
  const key = String(apiKey || "").trim();
  if (!key || isGatewayLocalKey(key)) return loadOfficialDeepseek();
  ensureHome();
  const next = {
    apiKey: key,
    baseUrl: String(baseUrl || OFFICIAL_DEEPSEEK_BASE).trim() || OFFICIAL_DEEPSEEK_BASE,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(storePath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function hasOfficialDeepseekKey() {
  return Boolean(loadOfficialDeepseek().apiKey);
}

export function officialModelMeta(modelId) {
  const id = String(modelId || "").trim();
  return OFFICIAL_DEEPSEEK_MODELS.find((m) => m.id === id) || null;
}

/** 构造官方转发用的伪候选（不进免费池冷却） */
export function officialCandidate(modelId) {
  const st = loadOfficialDeepseek();
  if (!st.apiKey) return null;
  const meta = officialModelMeta(modelId);
  return {
    connectionId: "official-deepseek",
    providerId: "deepseek-official",
    label: "DeepSeek 官方",
    tier: "paid",
    priority: 0,
    apiKey: st.apiKey,
    baseUrl: st.baseUrl || OFFICIAL_DEEPSEEK_BASE,
    upstreamModelId: modelId,
    capabilities: meta?.inputModalities || ["text"],
    official: true,
  };
}
