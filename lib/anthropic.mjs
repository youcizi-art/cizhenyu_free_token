/**
 * Anthropic Messages API → OpenAI chat/completions 适配（供 DSH llm-deepseek）。
 * DSH 请求：{baseURL}/v1/messages（baseURL 不含 /v1 时由客户端拼 /v1）。
 */
import { proxyChatCompletions } from "./proxy.mjs";

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return String(part.text || "");
      if (part?.type === "tool_result") return String(part.content || "");
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Anthropic messages → OpenAI chat body */
export function anthropicToOpenAI(body) {
  const messages = [];
  if (body?.system) {
    messages.push({ role: "system", content: contentToText(body.system) });
  }
  for (const m of body?.messages || []) {
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    messages.push({ role, content: contentToText(m.content) });
  }
  const out = {
    model: body?.model,
    messages,
    max_tokens: body?.max_tokens,
    temperature: body?.temperature,
    top_p: body?.top_p,
    stream: Boolean(body?.stream),
    stop: body?.stop_sequences,
  };
  return out;
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

export async function proxyAnthropicMessages(cfg, anthropicBody, { signal } = {}) {
  const openaiReq = anthropicToOpenAI(anthropicBody);
  if (anthropicBody?.stream) {
    // 流式：简化为非流式再包装（稳定优先；后续可再做 SSE 翻译）
    openaiReq.stream = false;
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
    body: openAIToAnthropic(result.body, openaiReq.model),
  };
}
