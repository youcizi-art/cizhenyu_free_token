/**
 * 逻辑模型 + 路由池（P0：auto-text；钉死物理模型仅同 id 换 Key）。
 */
import {
  LOGICAL_AUTO_TEXT,
  LOGICAL_AUTO_VISION,
  inferCapabilities,
} from "./config.mjs";
import {
  TIER_RANK,
  attachRoundRobinHints,
  isModelCooling,
  normalizeBase,
} from "./router.mjs";

export { LOGICAL_AUTO_TEXT, LOGICAL_AUTO_VISION, inferCapabilities };

export function isLogicalModel(id) {
  const m = String(id || "").trim();
  return m === LOGICAL_AUTO_TEXT || m === LOGICAL_AUTO_VISION || m.startsWith("cizhenyu/auto-");
}

export function detectModality(reqBody) {
  const messages = reqBody?.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const c = msg?.content;
      if (Array.isArray(c)) {
        for (const part of c) {
          const t = String(part?.type || "");
          if (
            t === "image_url" ||
            t === "input_image" ||
            t === "image" ||
            part?.image_url ||
            part?.source?.type === "base64"
          ) {
            return "vision";
          }
        }
      }
    }
  }
  return "text";
}

function sortCandidates(cfg, list) {
  const mode = cfg.strategy?.mode || "priority";
  const preferFree = cfg.strategy?.preferFree !== false;
  const arr = attachRoundRobinHints(list);
  arr.sort((a, b) => {
    if (preferFree) {
      const ta = TIER_RANK[a.tier] ?? 9;
      const tb = TIER_RANK[b.tier] ?? 9;
      if (ta !== tb) return ta - tb;
    }
    if (mode === "round_robin") {
      return (a._rr || 0) - (b._rr || 0) || (a.priority || 100) - (b.priority || 100);
    }
    return (a.priority || 100) - (b.priority || 100);
  });
  return arr;
}

/** 展开为候选：每条 = 连接 × 物理模型 */
export function buildCandidates(cfg, { capability = "text", physicalModel = null } = {}) {
  const now = Date.now();
  const out = [];
  for (const c of cfg.connections || []) {
    if (!c || c.enabled === false) continue;
    if (!normalizeBase(c.baseUrl) || !String(c.apiKey || "").trim()) continue;
    if (Number(c.cooldownUntil || 0) > now) continue;
    const caps = c.capabilities?.length
      ? c.capabilities
      : inferCapabilities(c.providerId, c.models);
    if (capability === "text" && !caps.includes("text") && !caps.includes("image")) {
      // 有 image 的一般也能做纯文本；仅无 text/image 才跳过
      continue;
    }
    if (capability === "image" && !caps.includes("image")) continue;

    const models = Array.isArray(c.models) ? c.models.map(String).filter(Boolean) : [];
    if (!models.length) continue;

    const wanted = physicalModel ? [physicalModel] : models;
    for (const mid of wanted) {
      if (physicalModel && !models.includes(mid) && models.length) {
        // 钉死模型：连接未声明该 id 则跳过（不拿去乱试）
        continue;
      }
      if (!physicalModel && !models.includes(mid)) continue;
      if (isModelCooling(c, mid, now)) continue;
      out.push({
        connectionId: c.id,
        providerId: c.providerId,
        label: c.label,
        tier: c.tier,
        priority: c.priority,
        apiKey: c.apiKey,
        baseUrl: c.baseUrl,
        upstreamModelId: mid,
        capabilities: caps,
      });
    }
  }
  return sortCandidates(cfg, out);
}

/**
 * @returns {{
 *   logical: string,
 *   allowRemap: boolean,
 *   modality: 'text'|'vision',
 *   candidates: object[],
 *   error?: { status: number, body: object }
 * }}
 */
export function resolveRoute(cfg, reqBody) {
  const logical = String(reqBody?.model || cfg.defaultModel || "").trim();
  const modality = detectModality(reqBody);
  const maxAttempts = Math.max(1, Number(cfg.strategy?.maxAttemptsPerRequest) || 5);

  if (!logical) {
    return {
      logical: "",
      allowRemap: true,
      modality,
      candidates: [],
      error: {
        status: 400,
        body: {
          error: {
            message: "缺少 model。请选择 cizhenyu/auto-text 或具体物理模型。",
            type: "missing_model",
          },
        },
      },
    };
  }

  if (logical === LOGICAL_AUTO_TEXT || logical === "auto" || logical === "cizhenyu/auto") {
    const cap = modality === "vision" ? "image" : "text";
    let candidates = buildCandidates(cfg, { capability: cap });
    if (!candidates.length && cap === "image") {
      return {
        logical: LOGICAL_AUTO_TEXT,
        allowRemap: true,
        modality,
        candidates: [],
        error: {
          status: 400,
          body: {
            error: {
              message:
                "请求含图像，但没有可用的视觉上游。请连接支持图像的商家，或去掉图片后使用文本。",
              type: "no_vision_upstream",
            },
          },
        },
      };
    }
    if (!candidates.length) {
      candidates = buildCandidates(cfg, { capability: "text" });
    }
    return {
      logical: LOGICAL_AUTO_TEXT,
      allowRemap: true,
      modality,
      candidates: candidates.slice(0, maxAttempts),
    };
  }

  if (logical === LOGICAL_AUTO_VISION) {
    const candidates = buildCandidates(cfg, { capability: "image" });
    return {
      logical: LOGICAL_AUTO_VISION,
      allowRemap: true,
      modality: "vision",
      candidates: candidates.slice(0, maxAttempts),
      error: candidates.length
        ? undefined
        : {
            status: 503,
            body: {
              error: {
                message: "没有可用的视觉连接。",
                type: "no_upstream",
              },
            },
          },
    };
  }

  // 物理模型：仅同 id 换 Key，不跨模型改写
  const candidates = buildCandidates(cfg, {
    capability: "text",
    physicalModel: logical,
  });
  // 未声明 capabilities 过滤过严时，再扫一遍不限 capability
  const pinned =
    candidates.length > 0
      ? candidates
      : buildCandidates(cfg, { capability: "image", physicalModel: logical });
  const list = (pinned.length ? pinned : buildPinnedLoose(cfg, logical)).slice(0, maxAttempts);

  return {
    logical,
    allowRemap: false,
    modality,
    candidates: list,
    error: list.length
      ? undefined
      : {
          status: 503,
          body: {
            error: {
              message: `没有可用连接声明模型 ${logical}（或均在冷却中）。`,
              type: "no_upstream",
            },
          },
        },
  };
}

function buildPinnedLoose(cfg, physicalModel) {
  const now = Date.now();
  const out = [];
  for (const c of cfg.connections || []) {
    if (!c || c.enabled === false) continue;
    if (!normalizeBase(c.baseUrl) || !String(c.apiKey || "").trim()) continue;
    if (Number(c.cooldownUntil || 0) > now) continue;
    const models = Array.isArray(c.models) ? c.models.map(String) : [];
    if (!models.includes(physicalModel)) continue;
    if (isModelCooling(c, physicalModel, now)) continue;
    out.push({
      connectionId: c.id,
      providerId: c.providerId,
      label: c.label,
      tier: c.tier,
      priority: c.priority,
      apiKey: c.apiKey,
      baseUrl: c.baseUrl,
      upstreamModelId: physicalModel,
      capabilities: c.capabilities || inferCapabilities(c.providerId, c.models),
    });
  }
  return sortCandidates(cfg, out);
}

export function poolStats(cfg) {
  const text = buildCandidates(cfg, { capability: "text" });
  const vision = buildCandidates(cfg, { capability: "image" });
  const coolingConn = (cfg.connections || []).filter(
    (c) => Number(c.cooldownUntil || 0) > Date.now(),
  ).length;
  let coolingModels = 0;
  for (const c of cfg.connections || []) {
    const mc = c.modelCooldowns || {};
    for (const until of Object.values(mc)) {
      if (Number(until) > Date.now()) coolingModels += 1;
    }
  }
  return {
    textCandidates: text.length,
    visionCandidates: vision.length,
    coolingConnections: coolingConn,
    coolingModels,
    autoText: LOGICAL_AUTO_TEXT,
    sampleText: text.slice(0, 5).map((c) => ({
      connectionId: c.connectionId,
      label: c.label,
      model: c.upstreamModelId,
      tier: c.tier,
    })),
  };
}
