/**
 * 将 OpenAI 兼容 chat/completions 转发到上游；按 upstreams 顺序 fallback。
 */

function normalizeBase(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function completionsUrl(baseUrl) {
  const base = normalizeBase(baseUrl);
  if (!base) return "";
  if (/\/chat\/completions\/?$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function enabledUpstreams(cfg) {
  return (cfg.upstreams || []).filter(
    (u) => u && u.enabled !== false && normalizeBase(u.baseUrl) && String(u.apiKey || "").trim(),
  );
}

function pickUpstream(cfg, model) {
  const list = enabledUpstreams(cfg);
  if (!list.length) return null;
  const m = String(model || "").trim();
  if (m) {
    const hit = list.find((u) => (u.models || []).includes(m));
    if (hit) return hit;
  }
  return list[0];
}

export async function proxyChatCompletions(cfg, reqBody, { signal } = {}) {
  const list = enabledUpstreams(cfg);
  if (!list.length) {
    return {
      status: 503,
      body: {
        error: {
          message:
            "No upstream configured. Open the gateway UI and add at least one OpenAI-compatible upstream with API key.",
          type: "no_upstream",
        },
      },
    };
  }

  const model = reqBody?.model || cfg.defaultModel || "";
  const ordered = [];
  const primary = pickUpstream(cfg, model);
  if (primary) ordered.push(primary);
  for (const u of list) {
    if (!ordered.includes(u)) ordered.push(u);
  }

  const errors = [];
  for (const up of ordered) {
    const url = completionsUrl(up.baseUrl);
    if (!url) continue;
    const body = { ...reqBody };
    if (!body.model && (up.models || [])[0]) {
      body.model = up.models[0];
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
          return { status: 502, body: { error: { message: "Upstream returned non-JSON", type: "bad_upstream" } } };
        }
        return {
          status: 200,
          body: parsed,
          upstreamId: up.id,
          stream: false,
        };
      }
      // 流式：若上游返回 SSE，原样透传较复杂；一期强制非流或缓冲
      errors.push({ id: up.id, status: res.status, body: text.slice(0, 400) });
      if (res.status === 401 || res.status === 403) continue;
      if (res.status >= 500) continue;
      // 4xx 其他：仍尝试下一个
      continue;
    } catch (e) {
      errors.push({ id: up.id, error: String(e?.message || e) });
    }
  }

  return {
    status: 502,
    body: {
      error: {
        message: "All upstreams failed",
        type: "upstream_exhausted",
        details: errors,
      },
    },
  };
}

/** 流式：优先命中上游，失败则返回 JSON 错误（非 SSE） */
export async function proxyChatCompletionsStream(cfg, reqBody, res, { signal } = {}) {
  const list = enabledUpstreams(cfg);
  if (!list.length) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "No upstream configured", type: "no_upstream" },
      }),
    );
    return;
  }

  const model = reqBody?.model || cfg.defaultModel || "";
  const ordered = [];
  const primary = pickUpstream(cfg, model);
  if (primary) ordered.push(primary);
  for (const u of list) {
    if (!ordered.includes(u)) ordered.push(u);
  }

  let lastErr = null;
  for (const up of ordered) {
    const url = completionsUrl(up.baseUrl);
    const body = { ...reqBody, stream: true };
    if (!body.model && (up.models || [])[0]) body.model = up.models[0];
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
        lastErr = { id: up.id, status: upstream.status, text: (await upstream.text()).slice(0, 300) };
        continue;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Cizhenyu-Upstream": up.id,
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
  res.end(JSON.stringify({ error: { message: "All upstreams failed", details: lastErr } }));
}
