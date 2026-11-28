/**
 * Anthropic Messages API → OpenAI chat/completions 适配（供 DSH llm-deepseek）。
 * DSH 请求：{baseURL}/v1/messages（baseURL 不含 /v1 时由客户端拼 /v1）。
 * 必须完整往返 tools / tool_use / tool_result；否则模型会把 DSML 当纯文本吐到聊天窗。
 */
import { proxyChatCompletions } from "./proxy.mjs";
import { promoteDsmlInOpenAIResponse } from "./dsml.mjs";

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

function toolResultToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (p?.type === "text") return String(p.text || "");
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Anthropic content → OpenAI content（字符串或 parts，保留图）；另收集 tool_use / tool_result */
function contentToOpenAIParts(content) {
  if (typeof content === "string") {
    return { content: content, toolCalls: [], toolResults: [] };
  }
  if (!Array.isArray(content)) {
    return { content: String(content ?? ""), toolCalls: [], toolResults: [] };
  }

  const parts = [];
  const toolCalls = [];
  const toolResults = [];
  let textOnly = true;
  let textBuf = [];

  for (const part of content) {
    if (typeof part === "string") {
      textBuf.push(part);
      parts.push({ type: "text", text: part });
      continue;
    }
    const t = String(part?.type || "");
    if (t === "text") {
      const tx = String(part.text || "");
      textBuf.push(tx);
      parts.push({ type: "text", text: tx });
      continue;
    }
    if (t === "tool_use") {
      toolCalls.push({
        id: String(part.id || `call_${toolCalls.length + 1}`),
        type: "function",
        function: {
          name: String(part.name || ""),
          arguments: JSON.stringify(
            part.input && typeof part.input === "object" ? part.input : {},
          ),
        },
      });
      continue;
    }
    if (t === "tool_result") {
      toolResults.push({
        tool_call_id: String(part.tool_use_id || part.id || ""),
        content: toolResultToText(part.content),
        is_error: Boolean(part.is_error),
      });
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
      parts.push(part);
      textOnly = false;
      continue;
    }
    if (t === "thinking") {
      // 上游 OpenAI 兼容一般不吃 thinking；跳过以免污染
      continue;
    }
  }

  let contentOut;
  if (!parts.length) contentOut = textBuf.join("\n") || null;
  else if (textOnly) contentOut = parts.map((p) => p.text || "").filter(Boolean).join("\n") || null;
  else contentOut = parts;

  return { content: contentOut, toolCalls, toolResults };
}

function mapAnthropicTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools
    .map((t) => {
      const name = String(t?.name || "").trim();
      if (!name) return null;
      return {
        type: "function",
        function: {
          name,
          description: String(t.description || ""),
          parameters:
            t.input_schema && typeof t.input_schema === "object"
              ? t.input_schema
              : t.parameters && typeof t.parameters === "object"
                ? t.parameters
                : { type: "object", properties: {} },
        },
      };
    })
    .filter(Boolean);
}

function mapAnthropicToolChoice(toolChoice) {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  const t = String(toolChoice?.type || "");
  if (t === "auto") return "auto";
  if (t === "any") return "required";
  if (t === "none") return "none";
  if (t === "tool" && toolChoice.name) {
    return { type: "function", function: { name: String(toolChoice.name) } };
  }
  return undefined;
}

/** Anthropic messages → OpenAI chat body（含 tools / tool_calls / tool results） */
export function anthropicToOpenAI(body) {
  const messages = [];
  if (body?.system) {
    const sys = contentToOpenAIParts(body.system);
    const text =
      typeof sys.content === "string"
        ? sys.content
        : Array.isArray(sys.content)
          ? sys.content.map((p) => p.text || "").join("\n")
          : "";
    if (text) messages.push({ role: "system", content: text });
  }

  for (const m of body?.messages || []) {
    const roleRaw = String(m?.role || "user");
    const parsed = contentToOpenAIParts(m.content);

    if (parsed.toolResults.length) {
      for (const tr of parsed.toolResults) {
        if (!tr.tool_call_id) continue;
        messages.push({
          role: "tool",
          tool_call_id: tr.tool_call_id,
          content: tr.content || "",
        });
      }
      // 同条里若还有用户文本/图，再跟一条 user
      if (parsed.content && (typeof parsed.content === "string" ? parsed.content.trim() : true)) {
        if (Array.isArray(parsed.content) && parsed.content.some((p) => p.type === "image_url")) {
          messages.push({ role: "user", content: parsed.content });
        } else if (typeof parsed.content === "string" && parsed.content.trim()) {
          messages.push({ role: "user", content: parsed.content });
        }
      }
      continue;
    }

    if (roleRaw === "assistant" || parsed.toolCalls.length) {
      const msg = {
        role: "assistant",
        content: typeof parsed.content === "string" ? parsed.content : null,
      };
      if (parsed.toolCalls.length) msg.tool_calls = parsed.toolCalls;
      messages.push(msg);
      continue;
    }

    messages.push({
      role: roleRaw === "system" ? "system" : "user",
      content: parsed.content == null ? "" : parsed.content,
    });
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

  const tools = mapAnthropicTools(body?.tools);
  if (tools?.length) out.tools = tools;
  const toolChoice = mapAnthropicToolChoice(body?.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  return out;
}

function parseToolArgs(raw) {
  try {
    const v = JSON.parse(String(raw || "{}"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** OpenAI chat completion → Anthropic message（含 tool_use；DSML 文本兜底） */
export function openAIToAnthropic(openaiBody, model) {
  const promoted = promoteDsmlInOpenAIResponse(openaiBody);
  const choice = promoted?.choices?.[0];
  const msg = choice?.message || {};
  const text = msg.content == null ? "" : String(msg.content);
  const finish = choice?.finish_reason;
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

  const content = [];
  if (text) content.push({ type: "text", text });
  for (const tc of toolCalls) {
    const name = String(tc?.function?.name || tc?.name || "").trim();
    if (!name) continue;
    content.push({
      type: "tool_use",
      id: String(tc.id || `toolu_${content.length + 1}`),
      name,
      input: parseToolArgs(tc?.function?.arguments ?? tc?.arguments),
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (finish === "length") stopReason = "max_tokens";
  else if (finish === "tool_calls" || toolCalls.length) stopReason = "tool_use";
  else if (finish === "stop") stopReason = "end_turn";

  return {
    id: promoted?.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: model || promoted?.model || "",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: promoted?.usage?.prompt_tokens ?? 0,
      output_tokens: promoted?.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * 把完整 Anthropic message 拆成 SSE 事件（含 message_stop + tool_use）。
 */
export function anthropicMessageToSSE(message) {
  const msg = message && typeof message === "object" ? message : {};
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const inputTokens = Number(msg.usage?.input_tokens || 0);
  const outputTokens = Number(msg.usage?.output_tokens || 0);
  const stopReason = msg.stop_reason || "end_turn";
  const id = msg.id || `msg_${Date.now()}`;
  const model = msg.model || "";

  const events = [
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
  ];

  blocks.forEach((block, index) => {
    const t = String(block?.type || "text");
    if (t === "tool_use") {
      const inputObj =
        block.input && typeof block.input === "object" ? block.input : {};
      const json = JSON.stringify(inputObj);
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: String(block.id || `toolu_${index}`),
            name: String(block.name || ""),
            input: {},
          },
        },
      });
      if (json && json !== "{}") {
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: json },
          },
        });
      }
      events.push({
        event: "content_block_stop",
        data: { type: "content_block_stop", index },
      });
      return;
    }

    const text = String(block?.text ?? "");
    events.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      },
    });
    if (text) {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text },
        },
      });
    }
    events.push({
      event: "content_block_stop",
      data: { type: "content_block_stop", index },
    });
  });

  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
  });
  events.push({
    event: "message_stop",
    data: { type: "message_stop" },
  });
  return events;
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
  // 有工具时给足输出额度；推理型上游过小 max_tokens 会空 content
  const mt = Number(openaiReq.max_tokens);
  const hasTools = Array.isArray(openaiReq.tools) && openaiReq.tools.length > 0;
  const minTok = hasTools ? 4096 : 1024;
  if (!Number.isFinite(mt) || mt < minTok) {
    openaiReq.max_tokens = minTok;
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
