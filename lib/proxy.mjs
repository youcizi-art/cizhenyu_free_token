/**
 * OpenAI chat/completions → 按 connections 策略轮换 / 回退。
 */
import {
  orderConnections,
  completionsUrl,
  isQuotaLikeError,
  markCooldown,
  bumpRoundRobin,
  attachRoundRobinHints,
} from "./router.mjs";

export async function proxyChatCompletions(cfg, reqBody, { signal } = {}) {
  let working = cfg;
  const model = reqBody?.model || working.defaultModel || "";
  let list = attachRoundRobinHints(orderConnections(working, model));
  if (!list.length) {
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
  for (const up of list) {
    const url = completionsUrl(up.baseUrl);
    if (!url) continue;
    const body = { ...reqBody };
    if (!body.model) {
      body.model = (up.models || [])[0] || working.defaultModel || "";
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${String(up.apiKey).trim()}`,
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
          return {
            status: 502,
            body: { error: { message: "Upstream returned non-JSON", type: "bad_upstream" } },
          };
        }
        bumpRoundRobin(up.id);
        return {
          status: 200,
          body: parsed,
          upstreamId: up.id,
          providerId: up.providerId,
          stream: false,
        };
      }
      errors.push({ id: up.id, label: up.label, status: res.status, body: text.slice(0, 400) });
      if (isQuotaLikeError(res.status, text)) {
        working = markCooldown(working, up.id);
        list = attachRoundRobinHints(orderConnections(working, model));
      }
    } catch (e) {
      errors.push({ id: up.id, label: up.label, error: String(e?.message || e) });
    }
  }

  return {
    status: 502,
    body: {
      error: {
        message: "所有可用连接均失败（可能额度用尽或密钥无效）",
        type: "upstream_exhausted",
        details: errors,
      },
    },
  };
}

export async function proxyChatCompletionsStream(cfg, reqBody, res, { signal } = {}) {
  let working = cfg;
  const model = reqBody?.model || working.defaultModel || "";
  let list = attachRoundRobinHints(orderConnections(working, model));
  if (!list.length) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "没有可用连接", type: "no_upstream" } }));
    return;
  }

  let lastErr = null;
  for (const up of list) {
    const url = completionsUrl(up.baseUrl);
    const body = { ...reqBody, stream: true };
    if (!body.model) body.model = (up.models || [])[0] || working.defaultModel || "";
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${String(up.apiKey).trim()}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text();
        lastErr = { id: up.id, status: upstream.status, text: text.slice(0, 300) };
        if (isQuotaLikeError(upstream.status, text)) {
          working = markCooldown(working, up.id);
          list = attachRoundRobinHints(orderConnections(working, model));
        }
        continue;
      }
      bumpRoundRobin(up.id);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Cizhenyu-Upstream": up.id,
        "X-Cizhenyu-Provider": up.providerId || "",
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
      lastErr = { id: up.id, error: String(e?.message || e) };
    }
  }

  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
  }
  res.end(JSON.stringify({ error: { message: "所有可用连接均失败", details: lastErr } }));
}
