/**
 * DeepSeek DSML 文本工具调用兜底解析。
 * 当上游（尤其是经网关转发的 VL 模型）把 DSML 当 content 吐出时，还原为 OpenAI tool_calls。
 */

const FW = "｜"; // fullwidth vertical line U+FF5C

function looseDsmlTag(kind) {
  // <｜｜DSML｜｜ calls> / </｜｜DSML｜｜ invoke> / </｜｜，DSML｜｜ calls>
  return new RegExp(
    `<[/]?${FW}+,?\\s*DSML\\s*${FW}+\\s*${kind}\\b([^>]*)>`,
    "gi",
  );
}

/**
 * @param {string} text
 * @returns {{ cleanedText: string, toolCalls: Array<{id:string,type:string,function:{name:string,arguments:string}}> }}
 */
export function extractDsmlToolCalls(text) {
  const raw = String(text || "");
  if (!/DSML/i.test(raw)) {
    return { cleanedText: raw, toolCalls: [] };
  }

  const toolCalls = [];
  let cleaned = raw;

  // Prefer full calls block; fall back to scanning invoke tags anywhere.
  const callsBlockRe = new RegExp(
    `<${FW}+\\s*DSML\\s*${FW}+\\s*calls\\s*>([\\s\\S]*?)<\\/?${FW}+,?\\s*DSML\\s*${FW}+\\s*calls\\s*>`,
    "gi",
  );
  const blocks = [];
  cleaned = cleaned.replace(callsBlockRe, (_m, inner) => {
    blocks.push(String(inner || ""));
    return "";
  });

  const scanTargets = blocks.length ? blocks : [raw];
  let idx = 0;
  for (const target of scanTargets) {
    const invokeRe = new RegExp(
      `<${FW}+\\s*DSML\\s*${FW}+\\s*invoke\\b([^>]*)>([\\s\\S]*?)<\\/?${FW}+\\s*DSML\\s*${FW}+\\s*invoke\\s*>`,
      "gi",
    );
    let m;
    while ((m = invokeRe.exec(target))) {
      const attrs = String(m[1] || "");
      const inner = String(m[2] || "");
      const nameMatch = attrs.match(/\bname\s*=\s*"([^"]+)"/i);
      const name = nameMatch?.[1]?.trim();
      if (!name) continue;
      const input = {};
      const paramRe = new RegExp(
        `<${FW}+\\s*DSML\\s*${FW}+\\s*parameter\\b([^>]*)>([\\s\\S]*?)<\\/?${FW}+\\s*DSML\\s*${FW}+\\s*parameter\\s*>`,
        "gi",
      );
      let pm;
      while ((pm = paramRe.exec(inner))) {
        const pattrs = String(pm[1] || "");
        const pval = String(pm[2] || "").trim();
        const pname = pattrs.match(/\bname\s*=\s*"([^"]+)"/i)?.[1];
        if (!pname) continue;
        const isString = /\bstring\s*=\s*"true"/i.test(pattrs);
        if (isString) {
          input[pname] = pval;
        } else {
          try {
            input[pname] = JSON.parse(pval);
          } catch {
            input[pname] = pval;
          }
        }
      }
      idx += 1;
      toolCalls.push({
        id: `call_dsml_${Date.now().toString(36)}_${idx}`,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(input),
        },
      });
    }
  }

  if (toolCalls.length) {
    // Strip any leftover DSML tags from visible text.
    cleaned = cleaned
      .replace(looseDsmlTag("calls"), "")
      .replace(looseDsmlTag("invoke"), "")
      .replace(looseDsmlTag("parameter"), "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return { cleanedText: cleaned, toolCalls };
}

/**
 * 若 OpenAI choice 只有文本里的 DSML、没有 tool_calls，则就地改写。
 * @param {object} openaiBody
 * @returns {object}
 */
export function promoteDsmlInOpenAIResponse(openaiBody) {
  if (!openaiBody || typeof openaiBody !== "object") return openaiBody;
  const choice = openaiBody.choices?.[0];
  const msg = choice?.message;
  if (!msg || typeof msg !== "object") return openaiBody;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return openaiBody;
  const content = typeof msg.content === "string" ? msg.content : "";
  if (!/DSML/i.test(content)) return openaiBody;
  const { cleanedText, toolCalls } = extractDsmlToolCalls(content);
  if (!toolCalls.length) return openaiBody;
  const next = {
    ...openaiBody,
    choices: [
      {
        ...choice,
        finish_reason: "tool_calls",
        message: {
          ...msg,
          content: cleanedText || null,
          tool_calls: toolCalls,
        },
      },
      ...(openaiBody.choices || []).slice(1),
    ],
  };
  return next;
}
