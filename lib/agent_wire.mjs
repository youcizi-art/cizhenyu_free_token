/**
 * 启停/保存后：备份并改写 DSH、OpenCode 模型切片；停止时恢复。
 * Deploy 仅注入 CIZHENYU_SYSTEM_ROOT。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homeDir } from "./paths.mjs";
import { loadConfig, listModelIds, effectiveDefaultModel } from "./config.mjs";

const STATE_NAME = "agent-wire.json";
const MANAGED_PROVIDER = "cizhenyu-free-token";
const DSH_OPS_ENV = ".cizhenyu-ops-env.json";
/** 写入 DSH cordis.patch.yml 的托管块：注入 llm-deepseek.models / baseURL */
const DSH_CORDIS_BEGIN = "# --- cizhenyu-free-token-begin ---";
const DSH_CORDIS_END = "# --- cizhenyu-free-token-end ---";

function systemRoot() {
  const fromEnv = String(process.env.CIZHENYU_SYSTEM_ROOT || "").trim();
  if (fromEnv) return fromEnv;
  return join(homeDir(), "..", "..");
}

function agentsDir() {
  return join(systemRoot(), "agents");
}

function statePath() {
  return join(homeDir(), STATE_NAME);
}

function loadState() {
  const p = statePath();
  if (!existsSync(p)) return { active: false };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { active: false };
  }
}

function saveState(st) {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(st, null, 2) + "\n", "utf8");
}

function readEndpoint() {
  const cfg = loadConfig();
  const port = Number(cfg.port) > 0 ? Number(cfg.port) : 20188;
  const key = String(cfg.localApiKey || "").trim();
  if (!key) throw new Error("本地 API Key 为空，请先保存配置");
  const models = listModelIds(cfg);
  const model = effectiveDefaultModel(cfg);
  if (!model) {
    throw new Error("尚未配置任何模型：请先从商家目录连接并填写模型 id");
  }
  return {
    port,
    /** DSH llm-deepseek：Messages 根，客户端会再拼 /v1/messages */
    dshBase: `http://127.0.0.1:${port}`,
    /** OpenCode OpenAI 兼容 */
    openaiBase: `http://127.0.0.1:${port}/v1`,
    key,
    model,
    models: models.length ? models : [model],
    cfg,
  };
}

function dshHome() {
  return join(agentsDir(), "dsh_agent", "home");
}

function dshInstalled() {
  const root = join(agentsDir(), "dsh_agent");
  return existsSync(join(root, "package.json")) || existsSync(join(root, "node_modules"));
}

function backupDsh() {
  const path = join(dshHome(), ".credentials.yaml");
  const bak = { hadDeepseekKey: false, deepseekApiKey: null };
  if (!existsSync(path)) return bak;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("DEEPSEEK_API_KEY:")) {
      bak.hadDeepseekKey = true;
      bak.deepseekApiKey = t.slice("DEEPSEEK_API_KEY:".length).trim().replace(/^"|"$/g, "");
      break;
    }
  }
  return bak;
}

function dshCordisPatchPath() {
  return join(dshHome(), "profiles", "web", "cordis.patch.yml");
}

function isTopLevelYamlItem(line) {
  return /^- /.test(line) || line.startsWith("#");
}

/** 删除顶层 yaml 文档项（从 `- id: …` 起到下一顶层项之前） */
function removeTopLevelYamlItems(raw, shouldDrop) {
  const lines = String(raw || "").split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("- id:")) {
      const block = [line];
      i += 1;
      while (i < lines.length && !isTopLevelYamlItem(lines[i])) {
        block.push(lines[i]);
        i += 1;
      }
      if (!shouldDrop(block.join("\n"))) out.push(...block);
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function stripDshCordisManaged(raw) {
  let text = String(raw || "");
  const begin = text.indexOf(DSH_CORDIS_BEGIN);
  if (begin >= 0) {
    const end = text.indexOf(DSH_CORDIS_END, begin);
    if (end < 0) text = text.slice(0, begin);
    else {
      const after = text.slice(end + DSH_CORDIS_END.length).replace(/^\r?\n/, "");
      text = text.slice(0, begin) + after;
    }
  }
  // 清理历史未加标记的网关注入残留
  text = removeTopLevelYamlItems(text, (block) => {
    if (block.startsWith("- id: llm-deepseek")) {
      return block.includes("127.0.0.1:") || block.includes("cizhenyu/auto");
    }
    if (block.startsWith("- id: agent-default-model")) {
      return (
        block.includes("deepseek-official") &&
        (block.includes("cizhenyu/auto") ||
          block.includes("openai/gpt-oss") ||
          block.includes("gemini-") ||
          block.includes("llama-"))
      );
    }
    return false;
  });
  return text.trimEnd();
}

function yamlQuote(s) {
  return JSON.stringify(String(s));
}

/**
 * 自定义 DEEPSEEK_BASE_URL 时 DSH 不会拉官方 /models，必须把网关模型写入 llm-deepseek.models，
 * 否则选择器仍只有 deepseek-flash / deepseek-v4-pro，网关模型无法使用。
 */
function applyDshCordis(dshBase, modelIds) {
  const path = dshCordisPatchPath();
  mkdirSync(dirname(path), { recursive: true });
  let raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  raw = stripDshCordisManaged(raw);
  const ids = (modelIds || []).filter(Boolean);
  if (!ids.length) {
    writeFileSync(path, raw ? `${raw.trimEnd()}\n` : "", "utf8");
    return;
  }
  const defaultId = ids.includes("cizhenyu/auto-text") ? "cizhenyu/auto-text" : ids[0];
  const modelsYaml = ids
    .map(
      (id) =>
        `      - id: ${yamlQuote(id)}\n        name: ${yamlQuote(id)}\n        inputModalities:\n          - text`,
    )
    .join("\n");
  const block = [
    DSH_CORDIS_BEGIN,
    "- id: llm-deepseek",
    "  config:",
    `    baseURL: ${yamlQuote(dshBase)}`,
    "    models:",
    modelsYaml,
    "- id: agent-default-model",
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    "  config:",
    "    provider: deepseek-official",
    `    model: ${yamlQuote(defaultId)}`,
    DSH_CORDIS_END,
    "",
  ].join("\n");
  const next = raw.trimEnd() ? `${raw.trimEnd()}\n${block}` : block;
  writeFileSync(path, next, "utf8");
}

function restoreDshCordis() {
  const path = dshCordisPatchPath();
  if (!existsSync(path)) return;
  const next = stripDshCordisManaged(readFileSync(path, "utf8"));
  writeFileSync(path, next ? `${next.trimEnd()}\n` : "", "utf8");
}

function dshCordisWired() {
  const path = dshCordisPatchPath();
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, "utf8");
  return raw.includes(DSH_CORDIS_BEGIN) && raw.includes("llm-deepseek");
}

function applyDsh(localKey, dshBase, modelIds) {
  const home = dshHome();
  mkdirSync(home, { recursive: true });
  const path = join(home, ".credentials.yaml");
  let raw = existsSync(path)
    ? readFileSync(path, "utf8")
    : "version: 1\nrecords: {}\nrefs: {}\n";
  const lines = raw.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("DEEPSEEK_API_KEY:")) {
      lines[i] = `  DEEPSEEK_API_KEY: ${localKey}`;
      replaced = true;
    }
  }
  if (!replaced) {
    if (!lines.some((l) => l.trimStart().startsWith("refs:"))) lines.push("refs:");
    lines.push(`  DEEPSEEK_API_KEY: ${localKey}`);
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  writeFileSync(
    join(home, DSH_OPS_ENV),
    JSON.stringify(
      {
        DEEPSEEK_API_KEY: localKey,
        DEEPSEEK_BASE_URL: dshBase,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  applyDshCordis(dshBase, modelIds);
}

function restoreDsh(bak) {
  const home = dshHome();
  try {
    unlinkSync(join(home, DSH_OPS_ENV));
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(join(home, ".cizhenyu-free-token-env.json"));
  } catch {
    /* ignore */
  }
  restoreDshCordis();
  const path = join(home, ".credentials.yaml");
  if (!existsSync(path)) return;
  let lines = readFileSync(path, "utf8").split(/\r?\n/);
  if (bak?.hadDeepseekKey) {
    const val = bak.deepseekApiKey || "";
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith("DEEPSEEK_API_KEY:")) {
        lines[i] = `  DEEPSEEK_API_KEY: ${val}`;
        replaced = true;
      }
    }
    if (!replaced) lines.push(`  DEEPSEEK_API_KEY: ${val}`);
  } else {
    lines = lines.filter((l) => !l.trim().startsWith("DEEPSEEK_API_KEY:"));
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

function opencodeJsonPath() {
  return join(agentsDir(), "opencode_agent", "home", "config", "opencode", "opencode.json");
}

function opencodeInstalled() {
  const root = join(agentsDir(), "opencode_agent");
  return (
    existsSync(join(root, "package.json")) ||
    existsSync(join(root, ".cizhenyu-installed")) ||
    existsSync(opencodeJsonPath())
  );
}

function backupOpencode() {
  const path = opencodeJsonPath();
  if (!existsSync(path)) return { model: null, provider: null, providers: null };
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return {
      model: Object.prototype.hasOwnProperty.call(v, "model") ? v.model : null,
      provider: Object.prototype.hasOwnProperty.call(v, "provider") ? v.provider : null,
      providers: Object.prototype.hasOwnProperty.call(v, "providers") ? v.providers : null,
      _hadFile: true,
    };
  } catch {
    return { model: null, provider: null, providers: null, _hadFile: true };
  }
}

function applyOpencode(openaiBase, localKey, modelId, modelIds) {
  const path = opencodeJsonPath();
  mkdirSync(dirname(path), { recursive: true });
  let root = {};
  if (existsSync(path)) {
    try {
      root = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      root = {};
    }
  }
  if (!root || typeof root !== "object") root = {};
  const models = {};
  for (const id of modelIds) {
    models[id] = { name: id };
  }
  root.model = `${MANAGED_PROVIDER}/${modelId}`;
  root.provider = {
    ...(typeof root.provider === "object" && root.provider ? root.provider : {}),
    [MANAGED_PROVIDER]: {
      npm: "@ai-sdk/openai-compatible",
      name: "Free Token Gateway",
      options: { baseURL: openaiBase, apiKey: localKey },
      models,
    },
  };
  writeFileSync(path, JSON.stringify(root, null, 2) + "\n", "utf8");
}

function restoreOpencode(bak) {
  const path = opencodeJsonPath();
  if (!existsSync(path)) return;
  let root;
  try {
    root = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
  if (!bak) return;
  if (bak.model != null) root.model = bak.model;
  else delete root.model;
  if (bak.provider != null) root.provider = bak.provider;
  else delete root.provider;
  if (bak.providers != null) root.providers = bak.providers;
  else delete root.providers;
  // 去掉我们注入的 provider 键若备份里没有整段 provider
  if (bak.provider == null && root.provider && root.provider[MANAGED_PROVIDER]) {
    delete root.provider[MANAGED_PROVIDER];
    if (!Object.keys(root.provider).length) delete root.provider;
  }
  writeFileSync(path, JSON.stringify(root, null, 2) + "\n", "utf8");
}

export function wireStatus() {
  const st = loadState();
  const cfg = loadConfig();
  const models = listModelIds(cfg);
  const port = cfg.port || st.gatewayPort || 20188;
  const active = Boolean(st.active);
  return {
    active,
    dshInstalled: dshInstalled(),
    opencodeInstalled: opencodeInstalled(),
    dshWired: Boolean(
      active && existsSync(join(dshHome(), DSH_OPS_ENV)) && dshCordisWired(),
    ),
    opencodeWired: Boolean(
      active &&
        existsSync(opencodeJsonPath()) &&
        (() => {
          try {
            const v = JSON.parse(readFileSync(opencodeJsonPath(), "utf8"));
            return Boolean(v?.provider?.[MANAGED_PROVIDER] || String(v?.model || "").startsWith(`${MANAGED_PROVIDER}/`));
          } catch {
            return false;
          }
        })(),
    ),
    gatewayPort: port,
    gatewayBaseUrl: `http://127.0.0.1:${port}/v1`,
    dshBaseUrl: `http://127.0.0.1:${port}`,
    defaultModel: effectiveDefaultModel(cfg),
    models,
    upstreamCount: (cfg.connections || []).filter(
      (c) => c.enabled !== false && String(c.apiKey || "").trim(),
    ).length,
    note: "改写配置后请重新打开 DSH / OpenCode。日常请选 cizhenyu/auto-text，额度用尽时由网关自动换家。",
  };
}

export function applyOnGatewayUp() {
  const ep = readEndpoint();
  const st = loadState();
  if (!st.active) {
    st.dsh = dshInstalled() ? backupDsh() : null;
    st.opencode = opencodeInstalled() ? backupOpencode() : null;
  }
  const errors = [];
  if (dshInstalled()) {
    try {
      applyDsh(ep.key, ep.dshBase, ep.models);
    } catch (e) {
      errors.push(`DSH: ${e?.message || e}`);
    }
  }
  if (opencodeInstalled()) {
    try {
      applyOpencode(ep.openaiBase, ep.key, ep.model, ep.models);
    } catch (e) {
      errors.push(`OpenCode: ${e?.message || e}`);
    }
  }
  st.active = true;
  st.gatewayPort = ep.port;
  st.gatewayBaseUrl = ep.openaiBase;
  st.dshBaseUrl = ep.dshBase;
  st.localApiKey = ep.key;
  st.defaultModel = ep.model;
  st.errors = errors;
  saveState(st);
  return { ...st, ...wireStatus(), errors };
}

export function restoreOnGatewayDown() {
  const st = loadState();
  if (!st.active) return { ...st, ...wireStatus() };
  if (st.dsh) restoreDsh(st.dsh);
  if (st.opencode) restoreOpencode(st.opencode);
  st.active = false;
  st.errors = [];
  saveState(st);
  return { ...st, ...wireStatus() };
}

export function reconcileIfStale(gatewayRunning) {
  const st = loadState();
  if (st.active && !gatewayRunning) {
    restoreOnGatewayDown();
  }
}
