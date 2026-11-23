/**
 * 按策略从 connections 中选出可用上游，并在失败时打冷却。
 */
import { saveConfig } from "./config.mjs";

const TIER_RANK = { free: 0, trial: 1, cheap: 2, paid: 3 };

function normalizeBase(url) {
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

/** 返回按尝试顺序排列的连接；model 优先匹配声明了该模型的连接 */
export function orderConnections(cfg, model) {
  const list = attachRoundRobinHints(enabledConnections(cfg));
  if (!list.length) return [];
  const sorted = sortConnections(cfg, list);
  const m = String(model || "").trim();
  if (!m) return sorted;
  const hit = sorted.filter((c) => (c.models || []).includes(m));
  const rest = sorted.filter((c) => !(c.models || []).includes(m));
  // 声明了该模型的优先；未声明的仍可作回退（部分商家忽略未知 model 字段）
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
    t.includes("限流")
  );
}

/** 标记冷却并落盘；返回更新后的 cfg */
export function markCooldown(cfg, connectionId, seconds) {
  const sec = Number(seconds) > 0 ? Number(seconds) : cfg.strategy?.cooldownSeconds || 120;
  const until = Date.now() + sec * 1000;
  const connections = (cfg.connections || []).map((c) =>
    c.id === connectionId ? { ...c, cooldownUntil: until } : c,
  );
  return saveConfig({ ...cfg, connections });
}

/** round_robin 计数（内存即可，重启归零） */
const rrCounters = new Map();

export function bumpRoundRobin(connectionId) {
  rrCounters.set(connectionId, (rrCounters.get(connectionId) || 0) + 1);
}

export function attachRoundRobinHints(list) {
  return list.map((c) => ({ ...c, _rr: rrCounters.get(c.id) || 0 }));
}
