/**
 * OpenAI chat/completions → 逻辑模型路由 / 官方 DeepSeek / 连接回退（P3）。
 */
import {
  completionsUrl,
  classifyUpstreamError,
  markModelCooldown,
  markAuthCooldown,
  bumpRoundRobin,
} from "./router.mjs";
import { resolveRoute, buildCandidates } from "./route_pool.mjs";
import { recordRouteOutcome } from "./route_stats.mjs";

function attemptHeaders(cand, logical) {
  return {
    "X-Cizhenyu-Upstream": cand.connectionId,
    "X-Cizhenyu-Provider": cand.providerId || "",
    "X-Cizhenyu-Mapped-Model": cand.upstreamModelId,
    "X-Cizhenyu-Logical-Model": logical,
  };
}

function applyFailure(working, cand, kind, allowRemap, strategy) {
  if (cand?.official) return working;
  if (kind === "quota") {
    // 429/额度：只冷却该模型，不整连接冷却（同连接其它模型仍可用）
    working = markModelCooldown(working, cand.connectionId, cand.upstreamModelId);
  } else if (kind === "auth") {
    working = markAuthCooldown(working, cand.connectionId);
  } else if (kind === "model_not_found") {
    const sec = allowRemap || strategy?.remapOnModelError !== false ? 120 : 30;
    working = markModelCooldown(working, cand.connectionId, cand.upstreamModelId, sec);
  }
  return working;
}

export async function proxyChatCompletions(cfg, reqBody, { signal } = {}) {
  let working = cfg;
  const route = resolveRoute(working, reqBody);
  if (route.error) {
    return { status: route.error.status, body: route.error.body };
  }
  const { logical, allowRemap, candidates } = route;
  const effectiveBody = route.reqBody || reqBody;
  if (!candidates.length) {
    return {
      status: 503,
      body: {
        error: {
          message:
            "没有可用连接。请打开配置页：从商家目录注册并回填 API Key，或检查连接是否在冷却中。",
          type: "no_upstream",
        },
      },
    };
  }

  const errors = [];
  for (const cand of candidates) {
    const url = completionsUrl(cand.baseUrl);
    if (!url) continue;
    const body = { ...effectiveBody, model: cand.upstreamModelId };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${String(cand.apiKey).trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      if (res.ok) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          recordRouteOutcome({
            ok: false,
            connectionId: cand.connectionId,
            providerId: cand.providerId,
            label: cand.label,
            model: cand.upstreamModelId,
            logical,
            kind: "bad_upstream",
            status: 502,
          });
          return {
            status: 502,
            body: { error: { message: "Upstream returned non-JSON", type: "bad_upstream" } },
          };
        }
        if (!cand.official) bumpRoundRobin(cand.connectionId);
        recordRouteOutcome({
          ok: true,
          connectionId: cand.connectionId,
          providerId: cand.providerId,
          label: cand.label,
          model: cand.upstreamModelId,
          logical,
          status: 200,
        });
        return {
          status: 200,
          body: parsed,
          upstreamId: cand.connectionId,
          providerId: cand.providerId,
          mappedModel: cand.upstreamModelId,
          logicalModel: logical,
          headers: attemptHeaders(cand, logical),
          stream: false,
        };
      }
      const kind = classifyUpstreamError(res.status, text);
      recordRouteOutcome({
        ok: false,
        connectionId: cand.connectionId,
        providerId: cand.providerId,
        label: cand.label,
        model: cand.upstreamModelId,
        logical,
        kind,
        status: res.status,
      });
      errors.push({
        id: cand.connectionId,
        label: cand.label,
        model: cand.upstreamModelId,
        status: res.status,
        kind,
        body: text.slice(0, 400),
      });
      working = applyFailure(working, cand, kind, allowRemap, working.strategy);
    } catch (e) {
      recordRouteOutcome({
        ok: false,
        connectionId: cand.connectionId,
        providerId: cand.providerId,
        label: cand.label,
        model: cand.upstreamModelId,
        logical,
        kind: "network",
      });
      errors.push({
        id: cand.connectionId,
        label: cand.label,
        model: cand.upstreamModelId,
        error: String(e?.message || e),
      });
    }
  }

  return {
    status: 502,
    body: {
      error: {
        message: `所有可用连接均失败（可能额度用尽、模型不可用、高峰限流或密钥无效）。逻辑模型 ${logical}；可改选 cizhenyu/auto 或其它物理模型重试。`,
        type: "upstream_exhausted",
        logicalModel: logical,
        details: errors,
      },
    },
  };
}

export async function proxyChatCompletionsStream(cfg, reqBody, res, { signal } = {}) {
  let working = cfg;
  const route = resolveRoute(working, reqBody);
  if (route.error) {
    res.writeHead(route.error.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(route.error.body));
    return;
  }
  const { logical, allowRemap, candidates } = route;
  const effectiveBody = route.reqBody || reqBody;
  if (!candidates.length) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "没有可用连接", type: "no_upstream" } }));
    return;
  }

  let lastErr = null;
  for (const cand of candidates) {
    const url = completionsUrl(cand.baseUrl);
    const body = { ...effectiveBody, stream: true, model: cand.upstreamModelId };
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${String(cand.apiKey).trim()}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text();
        const kind = classifyUpstreamError(upstream.status, text);
        recordRouteOutcome({
          ok: false,
          connectionId: cand.connectionId,
          providerId: cand.providerId,
          label: cand.label,
          model: cand.upstreamModelId,
          logical,
          kind,
          status: upstream.status,
        });
        lastErr = {
          id: cand.connectionId,
          model: cand.upstreamModelId,
          status: upstream.status,
          kind,
          text: text.slice(0, 300),
        };
        working = applyFailure(working, cand, kind, allowRemap, working.strategy);
        continue;
      }
      if (!cand.official) bumpRoundRobin(cand.connectionId);
      recordRouteOutcome({
        ok: true,
        connectionId: cand.connectionId,
        providerId: cand.providerId,
        label: cand.label,
        model: cand.upstreamModelId,
        logical,
        status: 200,
      });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...attemptHeaders(cand, logical),
      });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
      res.end();
      return;
    } catch (e) {
      recordRouteOutcome({
        ok: false,
        connectionId: cand.connectionId,
        providerId: cand.providerId,
        label: cand.label,
        model: cand.upstreamModelId,
        logical,
        kind: "network",
      });
      lastErr = { id: cand.connectionId, error: String(e?.message || e) };
    }
  }

  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
  }
  res.end(
    JSON.stringify({
      error: { message: "所有可用连接均失败", logicalModel: logical, details: lastErr },
    }),
  );
}

/** 生图：无上游则明确 400；有 image_gen 候选则尝试 OpenAI images API 形态 */
export async function proxyImageGenerations(cfg, reqBody, { signal } = {}) {
  const candidates = buildCandidates(cfg, { capability: "image_gen" });
  if (!candidates.length) {
    return {
      status: 400,
      body: {
        error: {
          message:
            "没有可用的生图上游。请连接支持 image_gen 的商家；本网关不会用聊天模型假装生图。",
          type: "no_image_gen_upstream",
        },
      },
    };
  }
  const maxAttempts = Math.max(1, Number(cfg.strategy?.maxAttemptsPerRequest) || 5);
  const errors = [];
  for (const cand of candidates.slice(0, maxAttempts)) {
    const base = String(cand.baseUrl || "").replace(/\/+$/, "");
    let url = `${base}/images/generations`;
    if (!/\/v1$/i.test(base) && !/\/images\/generations/i.test(base)) {
      url = `${base}/v1/images/generations`;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${String(cand.apiKey).trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...reqBody, model: cand.upstreamModelId }),
        signal,
      });
      const text = await res.text();
      if (res.ok) {
        try {
          return {
            status: 200,
            body: JSON.parse(text),
            headers: attemptHeaders(cand, "image_gen"),
          };
        } catch {
          return {
            status: 502,
            body: { error: { message: "Upstream returned non-JSON", type: "bad_upstream" } },
          };
        }
      }
      errors.push({
        id: cand.connectionId,
        model: cand.upstreamModelId,
        status: res.status,
        body: text.slice(0, 300),
      });
    } catch (e) {
      errors.push({ id: cand.connectionId, error: String(e?.message || e) });
    }
  }
  return {
    status: 502,
    body: {
      error: {
        message: "生图上游均失败",
        type: "upstream_exhausted",
        details: errors,
      },
    },
  };
}
