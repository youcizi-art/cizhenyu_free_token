/**
 * 连接排序、冷却、错误分类（P0 含连接级 + 模型级冷却）。
 */
import { saveConfig } from "./config.mjs";

export const TIER_RANK = { free: 0, trial: 1, cheap: 2, paid: 3 };

export function normalizeBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

export function completionsUrl(baseUrl) {
  const base = normalizeBase(baseUrl);
  if (!base) return "";
  if (/\/chat\/completions\/?$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  if (/\/openai\/v1$/i.test(base)) return `${base}/chat/completions`;
  if (/\/v1beta\/openai$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function enabledConnections(cfg) {
  const now = Date.now();
  return (cfg.connections || []).filter(
    (c) =>
      c &&
      c.enabled !== false &&
      normalizeBase(c.baseUrl) &&
      String(c.apiKey || "").trim() &&
      Number(c.cooldownUntil || 0) <= now,
  );
}

function sortConnections(cfg, list) {
  const mode = cfg.strategy?.mode || "priority";
  const preferFree = cfg.strategy?.preferFree !== false;
  const arr = [...list];
  arr.sort((a, b) => {
    if (preferFree) {
      const ta = TIER_RANK[a.tier] ?? 9;
      const tb = TIER_RANK[b.tier] ?? 9;
      if (ta !== tb) return ta - tb;
    }
    if (mode === "round_robin") {
      return (a._rr || 0) - (b._rr || 0) || a.priority - b.priority;
    }
    return (a.priority || 100) - (b.priority || 100);
  });
  return arr;
}

/** @deprecated 保留给旧调用；新路径用 route_pool.resolveRoute */
export function orderConnections(cfg, model) {
  const list = attachRoundRobinHints(enabledConnections(cfg));
  if (!list.length) return [];
  const sorted = sortConnections(cfg, list);
  const m = String(model || "").trim();
  if (!m) return sorted;
  const hit = sorted.filter((c) => (c.models || []).includes(m));
  const rest = sorted.filter((c) => !(c.models || []).includes(m));
  return [...hit, ...rest];
}

export function isQuotaLikeError(status, text) {
  if (status === 429 || status === 402) return true;
  const t = String(text || "").toLowerCase();
  return (
    t.includes("rate limit") ||
    t.includes("quota") ||
    t.includes("insufficient") ||
    t.includes("exceeded") ||
    t.includes("额度") ||
    t.includes("限流") ||
    t.includes("resource_exhausted") ||
    t.includes("too many requests")
  );
}

export function isAuthLikeError(status, text) {
  if (status === 401 || status === 403) return true;
  const t = String(text || "").toLowerCase();
  return (
    t.includes("invalid api key") ||
    t.includes("incorrect api key") ||
    t.includes("authentication") ||
    t.includes("unauthorized")
  );
}

export function isModelNotFoundError(status, text) {
  if (status !== 400 && status !== 404) return false;
  const t = String(text || "").toLowerCase();
  return (
    t.includes("model") &&
    (t.includes("not found") ||
      t.includes("does not exist") ||
      t.includes("unknown") ||
      t.includes("invalid") ||
      t.includes("unsupported"))
  );
}

export function classifyUpstreamError(status, text) {
  if (isQuotaLikeError(status, text)) return "quota";
  if (isAuthLikeError(status, text)) return "auth";
  if (isModelNotFoundError(status, text)) return "model_not_found";
  if (status >= 500 || status === 408 || status === 425) return "transient";
  return "other";
}

export function isModelCooling(connection, modelId, now = Date.now()) {
  const until = Number(connection?.modelCooldowns?.[modelId] || 0);
  return until > now;
}

/** 标记连接冷却并落盘 */
export function markCooldown(cfg, connectionId, seconds) {
  const sec = Number(seconds) > 0 ? Number(seconds) : cfg.strategy?.cooldownSeconds || 120;
  const until = Date.now() + sec * 1000;
  const connections = (cfg.connections || []).map((c) =>
    c.id === connectionId ? { ...c, cooldownUntil: until } : c,
  );
  return saveConfig({ ...cfg, connections });
}

/** 标记 (连接, 模型) 冷却 */
export function markModelCooldown(cfg, connectionId, modelId, seconds) {
  const sec =
    Number(seconds) > 0
      ? Number(seconds)
      : cfg.strategy?.modelCooldownSeconds || cfg.strategy?.cooldownSeconds || 300;
  const until = Date.now() + sec * 1000;
  const mid = String(modelId || "").trim();
  if (!mid) return cfg;
  const connections = (cfg.connections || []).map((c) => {
    if (c.id !== connectionId) return c;
    const modelCooldowns = { ...(c.modelCooldowns || {}), [mid]: until };
    return { ...c, modelCooldowns };
  });
  return saveConfig({ ...cfg, connections });
}

/** auth 失败：短冷却整连接，避免立刻重试坏 Key */
export function markAuthCooldown(cfg, connectionId) {
  return markCooldown(cfg, connectionId, Math.min(cfg.strategy?.cooldownSeconds || 120, 60));
}

const rrCounters = new Map();

export function bumpRoundRobin(connectionId) {
  rrCounters.set(connectionId, (rrCounters.get(connectionId) || 0) + 1);
}

export function attachRoundRobinHints(list) {
  return list.map((c) => ({
    ...c,
    _rr: rrCounters.get(c.connectionId || c.id) || 0,
  }));
}
