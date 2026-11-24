/**
 * P2：路由结果统计（成功率）+ 最近成功上游。
 * 落盘 home/route_stats.json；与 config 分离，避免写冷却时互相覆盖。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir, ensureHome } from "./paths.mjs";

const MAX_RECENT = 30;
const MAX_KEYS = 200;

function statsPath() {
  return join(homeDir(), "route_stats.json");
}

function emptyStats() {
  return {
    version: 1,
    lastSuccess: null,
    /** @type {Array<object>} */
    recent: [],
    /** @type {Record<string, { ok: number, fail: number, lastAt: number, lastKind?: string }>} */
    byKey: {},
    updatedAt: new Date().toISOString(),
  };
}

function keyOf(connectionId, modelId) {
  return `${connectionId}::${String(modelId || "").trim()}`;
}

let cache = null;
let dirty = false;
let flushTimer = null;

export function loadRouteStats() {
  ensureHome();
  if (cache) return cache;
  const p = statsPath();
  if (!existsSync(p)) {
    cache = emptyStats();
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    cache = {
      ...emptyStats(),
      ...raw,
      byKey: raw.byKey && typeof raw.byKey === "object" ? raw.byKey : {},
      recent: Array.isArray(raw.recent) ? raw.recent : [],
      lastSuccess: raw.lastSuccess || null,
    };
  } catch {
    cache = emptyStats();
  }
  return cache;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushRouteStats();
  }, 800);
}

export function flushRouteStats() {
  if (!dirty || !cache) return;
  ensureHome();
  cache.updatedAt = new Date().toISOString();
  writeFileSync(statsPath(), JSON.stringify(cache, null, 2) + "\n", "utf8");
  dirty = false;
}

function trimByKey(byKey) {
  const entries = Object.entries(byKey);
  if (entries.length <= MAX_KEYS) return byKey;
  entries.sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0));
  return Object.fromEntries(entries.slice(0, MAX_KEYS));
}

/**
 * @param {{
 *   ok: boolean,
 *   connectionId: string,
 *   providerId?: string,
 *   label?: string,
 *   model: string,
 *   logical?: string,
 *   kind?: string,
 *   status?: number,
 * }} ev
 */
export function recordRouteOutcome(ev) {
  const st = loadRouteStats();
  const now = Date.now();
  const connectionId = String(ev.connectionId || "");
  const model = String(ev.model || "").trim();
  if (!connectionId || !model) return st;

  const k = keyOf(connectionId, model);
  const prev = st.byKey[k] || { ok: 0, fail: 0, lastAt: 0 };
  const next = {
    ...prev,
    ok: prev.ok + (ev.ok ? 1 : 0),
    fail: prev.fail + (ev.ok ? 0 : 1),
    lastAt: now,
    lastKind: ev.ok ? "ok" : String(ev.kind || "fail"),
  };
  st.byKey = trimByKey({ ...st.byKey, [k]: next });

  const entry = {
    at: now,
    ok: Boolean(ev.ok),
    connectionId,
    providerId: ev.providerId || "",
    label: ev.label || "",
    model,
    logical: ev.logical || "",
    kind: ev.ok ? "ok" : String(ev.kind || "fail"),
    status: ev.status || 0,
  };
  st.recent = [entry, ...(st.recent || [])].slice(0, MAX_RECENT);

  if (ev.ok) {
    st.lastSuccess = {
      at: now,
      connectionId,
      providerId: ev.providerId || "",
      label: ev.label || "",
      model,
      logical: ev.logical || "",
    };
  }

  scheduleFlush();
  return st;
}

export function successRate(connectionId, modelId) {
  const st = loadRouteStats();
  const row = st.byKey[keyOf(connectionId, modelId)];
  if (!row) return null;
  const total = (row.ok || 0) + (row.fail || 0);
  if (!total) return null;
  return row.ok / total;
}

export function attemptsFor(connectionId, modelId) {
  const st = loadRouteStats();
  const row = st.byKey[keyOf(connectionId, modelId)];
  if (!row) return 0;
  return (row.ok || 0) + (row.fail || 0);
}

/** 供排序：无数据 → 0.55 中性；有数据按成功率 */
export function scoreForSort(connectionId, modelId) {
  const rate = successRate(connectionId, modelId);
  if (rate == null) return 0.55;
  return rate;
}

export function publicRouteStats(cfg) {
  const st = loadRouteStats();
  const now = Date.now();
  const byKey = [];
  for (const [k, row] of Object.entries(st.byKey || {})) {
    const [connectionId, ...rest] = k.split("::");
    const model = rest.join("::");
    const total = (row.ok || 0) + (row.fail || 0);
    if (!total) continue;
    const conn = (cfg?.connections || []).find((c) => c.id === connectionId);
    byKey.push({
      connectionId,
      label: conn?.label || connectionId,
      providerId: conn?.providerId || "",
      model,
      ok: row.ok || 0,
      fail: row.fail || 0,
      total,
      rate: Math.round((row.ok / total) * 1000) / 10,
      lastAt: row.lastAt || 0,
      lastKind: row.lastKind || "",
    });
  }
  byKey.sort((a, b) => b.total - a.total || b.lastAt - a.lastAt);

  const coolingModels = [];
  for (const c of cfg?.connections || []) {
    const mc = c.modelCooldowns || {};
    for (const [mid, until] of Object.entries(mc)) {
      if (Number(until) > now) {
        coolingModels.push({
          connectionId: c.id,
          label: c.label,
          model: mid,
          until: Number(until),
          remainSec: Math.ceil((Number(until) - now) / 1000),
        });
      }
    }
  }
  coolingModels.sort((a, b) => a.until - b.until);

  return {
    lastSuccess: st.lastSuccess,
    recent: (st.recent || []).slice(0, 12),
    byKey: byKey.slice(0, 20),
    coolingModels,
    updatedAt: st.updatedAt,
  };
}

export function resetRouteStats() {
  cache = emptyStats();
  dirty = true;
  flushRouteStats();
  return cache;
}
