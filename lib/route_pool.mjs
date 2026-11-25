/**
 * 逻辑模型 + 路由池（P3：auto 按内容分流；文件探测；官方 DeepSeek 直连）。
 */
import {
  LOGICAL_AUTO,
  LOGICAL_AUTO_TEXT,
  LOGICAL_AUTO_VISION,
  inferCapabilities,
  modelHasCapability,
  baseUrlUsable,
} from "./config.mjs";
import {
  TIER_RANK,
  attachRoundRobinHints,
  isModelCooling,
  normalizeBase,
} from "./router.mjs";
import { scoreForSort } from "./route_stats.mjs";
import {
  isOfficialDeepseekModel,
  officialCandidate,
  hasOfficialDeepseekKey,
} from "./official_deepseek.mjs";

export {
  LOGICAL_AUTO,
  LOGICAL_AUTO_TEXT,
  LOGICAL_AUTO_VISION,
  inferCapabilities,
  modelHasCapability,
};

const TEXT_FILE_HINT =
  /\.(txt|md|markdown|csv|json|jsonl|xml|html|htm|css|js|ts|tsx|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|yml|yaml|toml|ini|log|sql|sh|bat|ps1)$/i;

export function isLogicalModel(id) {
  const m = String(id || "").trim();
  return (
    m === LOGICAL_AUTO ||
    m === LOGICAL_AUTO_TEXT ||
    m === LOGICAL_AUTO_VISION ||
    m.startsWith("cizhenyu/auto")
  );
}

function partLooksVideo(part) {
  const t = String(part?.type || "");
  if (t === "video_url" || t === "input_video" || t === "video") return true;
  if (part?.video_url) return true;
  const url = String(part?.image_url?.url || part?.url || part?.file?.url || "");
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return true;
  const mt = String(part?.source?.media_type || part?.mime_type || part?.file?.mime_type || "");
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
    (part?.source?.type === "base64" &&
      String(part?.source?.media_type || "").startsWith("image/")) ||
    part?.source?.type === "url"
  ) {
    return !partLooksVideo(part);
  }
  const mt = String(part?.mime_type || part?.file?.mime_type || "");
  if (mt.startsWith("image/")) return true;
  return false;
}

function partLooksFile(part) {
  const t = String(part?.type || "");
  return (
    t === "file" ||
    t === "document" ||
    t === "input_file" ||
    Boolean(part?.file) ||
    Boolean(part?.document)
  );
}

function fileMimeAndName(part) {
  const mime = String(
    part?.mime_type ||
      part?.file?.mime_type ||
      part?.source?.media_type ||
      part?.document?.mime_type ||
      "",
  ).toLowerCase();
  const name = String(
    part?.filename || part?.file?.filename || part?.name || part?.document?.name || "",
  );
  return { mime, name };
}

/**
 * 规范化请求：把可解析文本文件抽成 text part；标记不支持的文件。
 * @returns {{ body: object, error?: { status: number, body: object }, forceVision?: boolean }}
 */
export function normalizeRequestBody(reqBody) {
  const body = { ...reqBody, messages: Array.isArray(reqBody?.messages) ? [...reqBody.messages] : [] };
  let forceVision = false;
  const messages = [];
  for (const msg of body.messages) {
    const c = msg?.content;
    if (!Array.isArray(c)) {
      messages.push(msg);
      continue;
    }
    const parts = [];
    for (const part of c) {
      if (partLooksVideo(part)) {
        return {
          body,
          error: {
            status: 400,
            body: {
              error: {
                message:
                  "当前网关尚未提供视频池。请去掉视频内容，或使用支持视频的物理上游。",
                type: "video_not_supported",
              },
            },
          },
        };
      }
      if (partLooksImage(part)) {
        forceVision = true;
        parts.push(part);
        continue;
      }
      if (partLooksFile(part)) {
        const { mime, name } = fileMimeAndName(part);
        if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(name)) {
          forceVision = true;
          // 尽量转成 image_url
          const url =
            part?.file?.url ||
            part?.url ||
            (part?.source?.type === "base64" && part?.source?.data
              ? `data:${mime || "image/png"};base64,${part.source.data}`
              : "");
          if (url) {
            parts.push({ type: "image_url", image_url: { url } });
          } else {
            parts.push(part);
          }
          continue;
        }
        if (
          mime.startsWith("text/") ||
          mime === "application/json" ||
          mime === "application/xml" ||
          TEXT_FILE_HINT.test(name)
        ) {
          let text = "";
          if (typeof part?.text === "string") text = part.text;
          else if (typeof part?.file?.content === "string") text = part.file.content;
          else if (part?.source?.type === "base64" && part?.source?.data) {
            try {
              text = Buffer.from(String(part.source.data), "base64").toString("utf8");
            } catch {
              text = "";
            }
          }
          if (!text) {
            return {
              body,
              error: {
                status: 400,
                body: {
                  error: {
                    message: `无法读取文本文件内容（${name || mime || "file"}）。请粘贴正文，或使用带文本内容的附件。`,
                    type: "unsupported_file",
                  },
                },
              },
            };
          }
          const label = name || "file";
          parts.push({
            type: "text",
            text: `\n--- file: ${label} ---\n${text}\n--- end file ---\n`,
          });
          continue;
        }
        return {
          body,
          error: {
            status: 400,
            body: {
              error: {
                message: `不支持的附件类型（${name || mime || "unknown"}）。请改用图片，或 txt/md/csv/json/代码等文本文件；PDF/Office 需先转文本。`,
                type: "unsupported_file",
              },
            },
          },
        };
      }
      parts.push(part);
    }
    messages.push({ ...msg, content: parts });
  }
  body.messages = messages;
  return { body, forceVision };
}

/** @returns {'text'|'vision'|'video'|'image_gen'} */
export function detectModality(reqBody) {
  if (reqBody?.__cizhenyuImageGen) return "image_gen";
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
  const preferReliable = cfg.strategy?.preferReliable !== false;
  const arr = attachRoundRobinHints(list);
  arr.sort((a, b) => {
    if (preferFree) {
      const ta = TIER_RANK[a.tier] ?? 9;
      const tb = TIER_RANK[b.tier] ?? 9;
      if (ta !== tb) return ta - tb;
    }
    if (preferReliable) {
      const sa = scoreForSort(a.connectionId, a.upstreamModelId);
      const sb = scoreForSort(b.connectionId, b.upstreamModelId);
      if (Math.abs(sa - sb) >= 0.15) return sb - sa;
    }
    if (mode === "round_robin") {
      return (a._rr || 0) - (b._rr || 0) || (a.priority || 100) - (b.priority || 100);
    }
    return (a.priority || 100) - (b.priority || 100);
  });
  return arr;
}

/** ????????????? maxAttempts ???????????? */
export function takeDiverseCandidates(cands, n) {
  const limit = Math.max(1, Number(n) || 5);
  const list = Array.isArray(cands) ? cands : [];
  const firstPass = [];
  const rest = [];
  const seen = new Set();
  for (const c of list) {
    const id = String(c?.connectionId || "");
    if (id && !seen.has(id)) {
      seen.add(id);
      firstPass.push(c);
    } else {
      rest.push(c);
    }
  }
  return [...firstPass, ...rest].slice(0, limit);
}

export function buildCandidates(cfg, { capability = "text", physicalModel = null } = {}) {
  const now = Date.now();
  const out = [];
  for (const c of cfg.connections || []) {
    if (!c || c.enabled === false) continue;
    if (!baseUrlUsable(c.baseUrl) || !String(c.apiKey || "").trim()) continue;
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
      } else if (capability === "image_gen") {
        if (!modelHasCapability(mid, "image_gen", c.providerId)) continue;
      } else if (capability === "text") {
        if (!modelHasCapability(mid, "text", c.providerId)) continue;
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

function err(status, type, message) {
  return {
    status,
    body: { error: { message, type } },
  };
}

/**
 * @returns {{
 *   logical: string,
 *   allowRemap: boolean,
 *   modality: string,
 *   candidates: object[],
 *   reqBody?: object,
 *   error?: { status: number, body: object }
 * }}
 */
export function resolveRoute(cfg, reqBody) {
  const normalized = normalizeRequestBody(reqBody || {});
  if (normalized.error) {
    return {
      logical: String(reqBody?.model || ""),
      allowRemap: false,
      modality: "text",
      candidates: [],
      error: normalized.error,
    };
  }
  const body = normalized.body;
  const logical = String(body?.model || cfg.defaultModel || "").trim();
  let modality = detectModality(body);
  if (normalized.forceVision && modality === "text") modality = "vision";
  const maxAttempts = Math.max(1, Number(cfg.strategy?.maxAttemptsPerRequest) || 5);

  if (!logical) {
    return {
      logical: "",
      allowRemap: true,
      modality,
      candidates: [],
      reqBody: body,
      error: err(
        400,
        "missing_model",
        "缺少 model。请选择 cizhenyu/auto、cizhenyu/auto-text、cizhenyu/auto-vision 或具体物理模型。",
      ),
    };
  }

  if (modality === "video") {
    return {
      logical,
      allowRemap: false,
      modality,
      candidates: [],
      reqBody: body,
      error: err(
        400,
        "video_not_supported",
        "当前网关尚未提供视频池。请去掉视频内容，或使用支持视频的物理上游。",
      ),
    };
  }

  if (modality === "image_gen") {
    const candidates = buildCandidates(cfg, { capability: "image_gen" });
    return {
      logical,
      allowRemap: true,
      modality,
      candidates: takeDiverseCandidates(candidates, maxAttempts),
      reqBody: body,
      error: candidates.length
        ? undefined
        : err(
            400,
            "no_image_gen_upstream",
            "没有可用的生图上游。请连接支持 image_gen 的商家，或改用聊天模型描述需求（本网关不会用聊天模型假装生图）。",
          ),
    };
  }

  // 官方 DeepSeek：钉死官方 id 时直连（有官方 Key）
  if (isOfficialDeepseekModel(logical) && !isLogicalModel(logical)) {
    const cand = officialCandidate(logical);
    if (cand) {
      if (modality === "vision") {
        const mods = cand.capabilities || [];
        if (!mods.includes("image") && !modelHasCapability(logical, "image", "deepseek")) {
          // deepseek-flash 带 image；其它官方纯文本遇图 → 明确错误
          const flash = officialCandidate("deepseek-flash");
          if (flash) {
            return {
              logical,
              allowRemap: false,
              modality,
              candidates: [flash],
              reqBody: { ...body, model: "deepseek-flash" },
            };
          }
          return {
            logical,
            allowRemap: false,
            modality,
            candidates: [],
            reqBody: body,
            error: err(
              400,
              "no_vision_upstream",
              `官方模型 ${logical} 不支持图像。请改选 deepseek-flash 或 cizhenyu/auto。`,
            ),
          };
        }
      }
      return {
        logical,
        allowRemap: false,
        modality,
        candidates: [cand],
        reqBody: body,
      };
    }
    // 无官方 Key：若免费池声明了同 id 也可；否则提示
  }

  if (logical === LOGICAL_AUTO || logical === "auto" || logical === "cizhenyu/auto") {
    if (modality === "vision") {
      let candidates = buildCandidates(cfg, { capability: "image" });
      const flash = officialCandidate("deepseek-flash");
      if (flash) candidates = [...candidates, flash];
      candidates = sortCandidates(cfg, candidates);
      return {
        logical: LOGICAL_AUTO,
        allowRemap: true,
        modality,
        candidates: takeDiverseCandidates(candidates, maxAttempts),
        reqBody: body,
        error: candidates.length
          ? undefined
          : err(
              400,
              "no_vision_upstream",
              "请求含图像，但没有可用的视觉上游。请连接 VL/Vision 商家，或配置官方 DeepSeek Key（deepseek-flash），或去掉图片。",
            ),
      };
    }
    let candidates = buildCandidates(cfg, { capability: "text" });
    if (!candidates.length) {
      candidates = buildCandidates(cfg, { capability: "image" });
    }
    // 官方模型作为文本回退（preferFree 时排在免费层之后）
    for (const oid of ["deepseek-flash", "deepseek-chat", "deepseek-v4-pro", "deepseek-reasoner"]) {
      const oc = officialCandidate(oid);
      if (oc) candidates.push(oc);
    }
    candidates = sortCandidates(cfg, candidates);
    return {
      logical: LOGICAL_AUTO,
      allowRemap: true,
      modality,
      candidates: takeDiverseCandidates(candidates, maxAttempts),
      reqBody: body,
      error: candidates.length
        ? undefined
        : err(
            503,
            "no_text_upstream",
            "没有可用的文本上游。请到商家目录连接并回填 API Key，或在 DSH 保留官方 DeepSeek Key 后再接线。",
          ),
    };
  }

  if (logical === LOGICAL_AUTO_TEXT) {
    if (modality === "vision") {
      const candidates = buildCandidates(cfg, { capability: "image" });
      const flash = officialCandidate("deepseek-flash");
      const list = sortCandidates(cfg, flash ? [...candidates, flash] : candidates);
      return {
        logical: LOGICAL_AUTO_TEXT,
        allowRemap: true,
        modality,
        candidates: takeDiverseCandidates(list, maxAttempts),
        reqBody: body,
        error: list.length
          ? undefined
          : err(
              400,
              "no_vision_upstream",
              "请求含图像，但没有可用的视觉模型。请连接带 VL 的商家，改选 cizhenyu/auto 或 auto-vision，或去掉图片。",
            ),
      };
    }
    let candidates = buildCandidates(cfg, { capability: "text" });
    if (!candidates.length) candidates = buildCandidates(cfg, { capability: "image" });
    return {
      logical: LOGICAL_AUTO_TEXT,
      allowRemap: true,
      modality,
      candidates: takeDiverseCandidates(candidates, maxAttempts),
      reqBody: body,
      error: candidates.length
        ? undefined
        : err(503, "no_text_upstream", "没有可用的文本上游。请连接商家并回填 Key。"),
    };
  }

  if (logical === LOGICAL_AUTO_VISION) {
    let candidates = buildCandidates(cfg, { capability: "image" });
    const flash = officialCandidate("deepseek-flash");
    if (flash) candidates = sortCandidates(cfg, [...candidates, flash]);
    return {
      logical: LOGICAL_AUTO_VISION,
      allowRemap: true,
      modality: "vision",
      candidates: takeDiverseCandidates(candidates, maxAttempts),
      reqBody: body,
      error: candidates.length
        ? undefined
        : err(
            503,
            "no_vision_upstream",
            "没有可用的视觉模型候选。请连接 VL/Vision 商家，或配置官方 DeepSeek Key。",
          ),
    };
  }

  // 物理模型：优先钉死同 id；remapOnModelError 时追加同连接/其它连接回退。
  // 否则上游单模型 503（如 Gemini high demand）时请求整死，而 auto 换 id 却能通——体感「auto 可用、点名反而不可用」。
  const cap = modality === "vision" ? "image" : "text";
  const remap = cfg.strategy?.remapOnModelError !== false;
  let exact = buildCandidates(cfg, { capability: cap, physicalModel: logical });
  if (!exact.length) {
    exact = buildCandidates(cfg, { capability: "image", physicalModel: logical });
  }
  if (!exact.length) exact = buildPinnedLoose(cfg, logical);

  let merged = [...exact];
  if (remap) {
    const preferConn = new Set(
      (cfg.connections || [])
        .filter((c) => (c.models || []).map(String).includes(logical))
        .map((c) => c.id),
    );
    const preferProv = new Set(
      (cfg.connections || [])
        .filter((c) => (c.models || []).map(String).includes(logical))
        .map((c) => c.providerId),
    );
    const pool = buildCandidates(cfg, { capability: cap });
    const seen = new Set(merged.map((c) => `${c.connectionId}::${c.upstreamModelId}`));
    const ranked = [...pool].sort((a, b) => {
      const rank = (c) =>
        preferConn.has(c.connectionId) ? 0 : preferProv.has(c.providerId) ? 1 : 2;
      return rank(a) - rank(b);
    });
    for (const c of ranked) {
      const k = `${c.connectionId}::${c.upstreamModelId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(c);
    }
  }

  // 物理+remap：保持「钉死 id → 同连接其它模型 → 其它连接」顺序，勿用 takeDiverse 打乱
  // （否则会先跳到另一家，点名 Gemini 却落到智谱，体感更怪）
  const list = remap
    ? merged.slice(0, maxAttempts)
    : takeDiverseCandidates(merged, maxAttempts);

  if (modality === "vision" && list.length) {
    const ok = list.filter(
      (c) =>
        modelHasCapability(c.upstreamModelId, "image", c.providerId) ||
        (c.capabilities || []).includes("image"),
    );
    if (!ok.length) {
      return {
        logical,
        allowRemap: false,
        modality,
        candidates: [],
        reqBody: body,
        error: err(
          400,
          "no_vision_upstream",
          `模型 ${logical} 不支持图像。请改选 cizhenyu/auto、auto-vision，或带 VL 的物理模型。`,
        ),
      };
    }
  }

  return {
    logical,
    allowRemap: remap,
    modality,
    candidates: list,
    reqBody: body,
    error: list.length
      ? undefined
      : err(503, "no_upstream", physicalUnavailableMessage(cfg, logical)),
  };
}

function physicalUnavailableMessage(cfg, logical) {
  const now = Date.now();
  const cooling = [];
  const alts = [];
  let declared = false;
  for (const c of cfg.connections || []) {
    if (!c || c.enabled === false) continue;
    if (!baseUrlUsable(c.baseUrl) || !String(c.apiKey || "").trim()) continue;
    const models = Array.isArray(c.models) ? c.models.map(String) : [];
    if (models.includes(logical)) {
      declared = true;
      const until = Number(c.modelCooldowns?.[logical] || 0);
      if (Number(c.cooldownUntil || 0) > now) {
        cooling.push(`${c.label} 整连接冷却 ${Math.max(1, Math.ceil((c.cooldownUntil - now) / 1000))}s`);
      } else if (until > now) {
        cooling.push(`${c.label}/${logical} 冷却 ${Math.max(1, Math.ceil((until - now) / 1000))}s`);
      }
    }
    for (const m of models) {
      if (m === logical) continue;
      if (Number(c.cooldownUntil || 0) > now) continue;
      if (isModelCooling(c, m, now)) continue;
      if (!alts.includes(m)) alts.push(m);
    }
  }
  const tip =
    isOfficialDeepseekModel(logical) && !hasOfficialDeepseekKey()
      ? "若这是官方 DeepSeek 模型，请先保存官方 Key 后再接线。"
      : "";
  if (cooling.length) {
    return `模型 ${logical} 暂不可用（${cooling.join("；")}）。可改选 ${
      alts.slice(0, 4).join("、") || "cizhenyu/auto"
    }，或稍后再试。${tip}`;
  }
  if (declared) {
    return `模型 ${logical} 暂无可用上游。可改选 ${alts.slice(0, 4).join("、") || "cizhenyu/auto"}。${tip}`;
  }
  return `没有可用连接声明模型 ${logical}。可改选 ${
    alts.slice(0, 4).join("、") || "cizhenyu/auto"
  }，或在配置页把该模型加到对应连接。${tip}`;
}

function buildPinnedLoose(cfg, physicalModel) {
  const now = Date.now();
  const out = [];
  for (const c of cfg.connections || []) {
    if (!c || c.enabled === false) continue;
    if (!baseUrlUsable(c.baseUrl) || !String(c.apiKey || "").trim()) continue;
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
  const imageGen = buildCandidates(cfg, { capability: "image_gen" });
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
    imageGenCandidates: imageGen.length,
    coolingConnections: coolingConn,
    coolingModels,
    auto: LOGICAL_AUTO,
    autoText: LOGICAL_AUTO_TEXT,
    autoVision: LOGICAL_AUTO_VISION,
    officialDeepseek: hasOfficialDeepseekKey(),
    sampleText: sample(text),
    sampleVision: sample(vision),
  };
}
