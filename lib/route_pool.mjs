/**
 * 逻辑模型 + 路由池（P1：auto-text / auto-vision；按模型能力进池）。
 */
import {
  LOGICAL_AUTO_TEXT,
  LOGICAL_AUTO_VISION,
  inferCapabilities,
  modelHasCapability,
} from "./config.mjs";
import {
  TIER_RANK,
  attachRoundRobinHints,
  isModelCooling,
  normalizeBase,
} from "./router.mjs";

export {
  LOGICAL_AUTO_TEXT,
  LOGICAL_AUTO_VISION,
  inferCapabilities,
  modelHasCapability,
};

export function isLogicalModel(id) {
  const m = String(id || "").trim();
  return m === LOGICAL_AUTO_TEXT || m === LOGICAL_AUTO_VISION || m.startsWith("cizhenyu/auto-");
}

function partLooksVideo(part) {
  const t = String(part?.type || "");
  if (t === "video_url" || t === "input_video" || t === "video") return true;
  if (part?.video_url) return true;
  const url = String(part?.image_url?.url || part?.url || "");
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return true;
  const mt = String(part?.source?.media_type || part?.mime_type || "");
  if (mt.startsWith("video/")) return true;
  return false;
}

function partLooksImage(part) {
  const t = String(part?.type || "");
  if (
    t === "image_url" ||
    t === "input_image" ||
    t === "image" ||
    part?.image_url ||
    part?.source?.type === "base64" ||
    part?.source?.type === "url"
  ) {
    return !partLooksVideo(part);
  }
  return false;
}

/** @returns {'text'|'vision'|'video'} */
export function detectModality(reqBody) {
  const messages = reqBody?.messages;
  let sawImage = false;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const c = msg?.content;
      if (!Array.isArray(c)) continue;
      for (const part of c) {
        if (partLooksVideo(part)) return "video";
        if (partLooksImage(part)) sawImage = true;
      }
    }
  }
  if (sawImage) return "vision";
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

/** 展开为候选：每条 = 连接 × 物理模型（P1：image/video 按单模型能力过滤） */
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

    const models = Array.isArray(c.models) ? c.models.map(String).filter(Boolean) : [];
    if (!models.length) continue;

    const wanted = physicalModel ? [physicalModel] : models;
    for (const mid of wanted) {
      if (physicalModel && !models.includes(mid) && models.length) continue;
      if (!physicalModel && !models.includes(mid)) continue;
      if (isModelCooling(c, mid, now)) continue;

      if (capability === "image") {
        if (!modelHasCapability(mid, "image", c.providerId)) continue;
      } else if (capability === "video") {
        if (!modelHasCapability(mid, "video", c.providerId)) continue;
      } else if (capability === "text") {
        // 纯文本池：允许视觉模型兼做文本；排除仅 video 的极端项
        if (!modelHasCapability(mid, "text", c.providerId)) continue;
        if (
          !caps.includes("text") &&
          !caps.includes("image") &&
          !modelHasCapability(mid, "image", c.providerId)
        ) {
          continue;
        }
      }

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
 *   modality: 'text'|'vision'|'video',
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
            message: "缺少 model。请选择 cizhenyu/auto-text、cizhenyu/auto-vision 或具体物理模型。",
            type: "missing_model",
          },
        },
      },
    };
  }

  if (modality === "video") {
    return {
      logical,
      allowRemap: false,
      modality,
      candidates: [],
      error: {
        status: 400,
        body: {
          error: {
            message:
              "当前网关尚未提供视频池（cizhenyu/auto-video 暂缓）。请去掉视频内容，或使用支持视频的物理上游。",
            type: "video_not_supported",
          },
        },
      },
    };
  }

  if (logical === LOGICAL_AUTO_TEXT || logical === "auto" || logical === "cizhenyu/auto") {
    if (modality === "vision") {
      const candidates = buildCandidates(cfg, { capability: "image" });
      return {
        logical: LOGICAL_AUTO_TEXT,
        allowRemap: true,
        modality,
        candidates: candidates.slice(0, maxAttempts),
        error: candidates.length
          ? undefined
          : {
              status: 400,
              body: {
                error: {
                  message:
                    "请求含图像，但没有可用的视觉模型。请连接带 VL/Vision 的商家，改选 cizhenyu/auto-vision，或去掉图片。",
                  type: "no_vision_upstream",
                },
              },
            },
      };
    }
    let candidates = buildCandidates(cfg, { capability: "text" });
    if (!candidates.length) {
      candidates = buildCandidates(cfg, { capability: "image" });
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
                message:
                  "没有可用的视觉模型候选。请连接声明了 VL/Vision 模型的商家并回填 Key。",
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
  const sample = (list) =>
    list.slice(0, 5).map((c) => ({
      connectionId: c.connectionId,
      label: c.label,
      model: c.upstreamModelId,
      tier: c.tier,
    }));
  return {
    textCandidates: text.length,
    visionCandidates: vision.length,
    coolingConnections: coolingConn,
    coolingModels,
    autoText: LOGICAL_AUTO_TEXT,
    autoVision: LOGICAL_AUTO_VISION,
    sampleText: sample(text),
    sampleVision: sample(vision),
  };
}
