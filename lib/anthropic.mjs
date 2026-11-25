/**
 * Anthropic Messages API → OpenAI chat/completions 适配（供 DSH llm-deepseek）。
 * DSH 请求：{baseURL}/v1/messages（baseURL 不含 /v1 时由客户端拼 /v1）。
 * P1：保留 image 块，供视觉路由与上游多模态转发。
 */
import { proxyChatCompletions } from "./proxy.mjs";

function anthropicImageToOpenAI(part) {
  const src = part?.source;
  if (!src || typeof src !== "object") return null;
  if (src.type === "url" && src.url) {
    return { type: "image_url", image_url: { url: String(src.url) } };
  }
  if (src.type === "base64" && src.data) {
    const mt = String(src.media_type || "image/jpeg");
    return {
      type: "image_url",
      image_url: { url: `data:${mt};base64,${String(src.data)}` },
    };
  }
  return null;
}

/** Anthropic content → OpenAI content（字符串或 parts，保留图） */
function contentToOpenAI(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const parts = [];
  let textOnly = true;
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    const t = String(part?.type || "");
    if (t === "text") {
      parts.push({ type: "text", text: String(part.text || "") });
      continue;
    }
    if (t === "tool_result") {
      parts.push({ type: "text", text: String(part.content || "") });
      continue;
    }
    if (t === "image") {
      const img = anthropicImageToOpenAI(part);
      if (img) {
        parts.push(img);
        textOnly = false;
      }
      continue;
    }
    if (t === "image_url" || part?.image_url) {
      parts.push({
        type: "image_url",
        image_url:
          typeof part.image_url === "object"
            ? part.image_url
            : { url: String(part.image_url || "") },
      });
      textOnly = false;
      continue;
    }
    if (t === "document" || t === "file" || t === "input_file" || part?.file || part?.document) {
      // 交给网关 normalizeRequestBody 做文本抽取 / 不支持类型判定
      parts.push(part);
      textOnly = false;
      continue;
    }
  }

  if (!parts.length) return "";
  if (textOnly) {
    return parts
      .map((p) => p.text || "")
      .filter(Boolean)
      .join("\n");
  }
  return parts;
}

/** Anthropic messages → OpenAI chat body */
export function anthropicToOpenAI(body) {
  const messages = [];
  if (body?.system) {
    const sys = contentToOpenAI(body.system);
    messages.push({
      role: "system",
      content: typeof sys === "string" ? sys : sys.map((p) => p.text || "").join("\n"),
    });
  }
  for (const m of body?.messages || []) {
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    messages.push({ role, content: contentToOpenAI(m.content) });
  }
  return {
    model: body?.model,
    messages,
    max_tokens: body?.max_tokens,
    temperature: body?.temperature,
    top_p: body?.top_p,
    stream: Boolean(body?.stream),
    stop: body?.stop_sequences,
  };
}

/** OpenAI chat completion → Anthropic message */
export function openAIToAnthropic(openaiBody, model) {
  const choice = openaiBody?.choices?.[0];
  const text = choice?.message?.content ?? "";
  const finish = choice?.finish_reason;
  let stopReason = "end_turn";
  if (finish === "length") stopReason = "max_tokens";
  else if (finish === "tool_calls") stopReason = "tool_use";
  else if (finish === "stop") stopReason = "end_turn";
  return {
    id: openaiBody?.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model || openaiBody?.model || "",
    content: [{ type: "text", text: String(text) }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiBody?.usage?.prompt_tokens ?? 0,
      output_tokens: openaiBody?.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * 把完整 Anthropic message 拆成 SSE 事件（含 message_stop）。
 * DSH 流式客户端若收不到 message_stop 会报
 * “DeepSeek Messages stream ended before message_stop”。
 */
export function anthropicMessageToSSE(message) {
  const msg = message && typeof message === "object" ? message : {};
  const text = String(msg.content?.[0]?.text ?? "");
  const inputTokens = Number(msg.usage?.input_tokens || 0);
  const outputTokens = Number(msg.usage?.output_tokens || 0);
  const stopReason = msg.stop_reason || "end_turn";
  const id = msg.id || `msg_${Date.now()}`;
  const model = msg.model || "";

  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    ...(text
      ? [
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            },
          },
        ]
      : []),
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      },
    },
    {
      event: "message_stop",
      data: { type: "message_stop" },
    },
  ];
}

export function writeAnthropicSSE(res, message, extraHeaders = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  for (const ev of anthropicMessageToSSE(message)) {
    res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  }
  res.end();
}

export async function proxyAnthropicMessages(cfg, anthropicBody, { signal } = {}) {
  const openaiReq = anthropicToOpenAI(anthropicBody);
  // 上游一律非流式取完整结果；若客户端要 stream，再由 writeAnthropicSSE 包装
  openaiReq.stream = false;
  // 推理型上游（gpt-oss 等）在过小 max_tokens 时会返回空 content
  const mt = Number(openaiReq.max_tokens);
  if (!Number.isFinite(mt) || mt < 256) {
    openaiReq.max_tokens = 1024;
  }
  const result = await proxyChatCompletions(cfg, openaiReq, { signal });
  if (result.status >= 400) {
    return {
      status: result.status,
      body: {
        type: "error",
        error: {
          type: result.body?.error?.type || "api_error",
          message: result.body?.error?.message || "upstream error",
        },
      },
    };
  }
  return {
    status: 200,
    body: openAIToAnthropic(result.body, result.mappedModel || openaiReq.model),
    headers: result.headers,
    mappedModel: result.mappedModel,
    logicalModel: result.logicalModel,
    upstreamId: result.upstreamId,
    providerId: result.providerId,
    stream: Boolean(anthropicBody?.stream),
  };
}
