/**
 * 启停/保存后：备份并改写 DSH、OpenCode 模型切片；停止时恢复。
 * P3：完整备份 cordis；官方 DeepSeek Key 外置；合并注入官方模型 + auto-*。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { homeDir } from "./paths.mjs";
import {
  loadConfig,
  listModelIds,
  effectiveDefaultModel,
  LOGICAL_AUTO,
  LOGICAL_AUTO_TEXT,
  LOGICAL_AUTO_VISION,
  modelHasCapability,
} from "./config.mjs";
import {
  OFFICIAL_DEEPSEEK_MODELS,
  isGatewayLocalKey,
  loadOfficialDeepseek,
  saveOfficialDeepseek,
  hasOfficialDeepseekKey,
  isOfficialDeepseekModel,
} from "./official_deepseek.mjs";

const STATE_NAME = "agent-wire.json";
const MANAGED_PROVIDER = "cizhenyu-free-token";
const DSH_OPS_ENV = ".cizhenyu-ops-env.json";
const DSH_CORDIS_BAK = "dsh-cordis.bak.yml";
const DSH_CORDIS_BEGIN = "# --- cizhenyu-free-token-begin ---";
const DSH_CORDIS_END = "# --- cizhenyu-free-token-end ---";

function systemRoot() {
  const fromEnv = String(process.env.CIZHENYU_SYSTEM_ROOT || "").trim();
  if (fromEnv) return fromEnv;
  // home = {systemRoot}/scripts/free-token/home → 上溯三级才是 systemRoot
  // 旧代码少一层会落到 scripts/，导致接线/恢复完全打不到 agents/
  const candidates = [
    join(homeDir(), "..", "..", ".."),
    join(homeDir(), "..", ".."),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "agents", "dsh_agent")) || existsSync(join(c, "agents"))) {
      return c;
    }
  }
  return candidates[0];
}

function agentsDir() {
  return join(systemRoot(), "agents");
}

function statePath() {
  return join(homeDir(), STATE_NAME);
}

function cordisBakPath() {
  return join(homeDir(), DSH_CORDIS_BAK);
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
  if (!model && !hasOfficialDeepseekKey()) {
    throw new Error("尚未配置任何模型：请先从商家目录连接并填写模型 id，或保留官方 DeepSeek Key");
  }
  return {
    port,
    dshBase: `http://127.0.0.1:${port}`,
    openaiBase: `http://127.0.0.1:${port}/v1`,
    key,
    model: model || LOGICAL_AUTO || LOGICAL_AUTO_TEXT,
    models: models.length ? models : [model || LOGICAL_AUTO_TEXT],
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

function readDeepseekKeyFromCredentials() {
  const path = join(dshHome(), ".credentials.yaml");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  // 块映射：  DEEPSEEK_API_KEY: sk-...
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("DEEPSEEK_API_KEY:")) {
      return t.slice("DEEPSEEK_API_KEY:".length).trim().replace(/^"|"$/g, "");
    }
  }
  // inline：refs: { DEEPSEEK_API_KEY: sk-... }
  const inline = raw.match(
    /refs\s*:\s*\{[^}]*\bDEEPSEEK_API_KEY\s*:\s*([^,}\n]+)/,
  );
  if (inline) {
    return String(inline[1] || "")
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return null;
}

function parseDefaultModelFromCordis(raw) {
  const text = String(raw || "");
  const idx = text.indexOf("- id: agent-default-model");
  if (idx < 0) return null;
  const slice = text.slice(idx, idx + 500);
  const m = slice.match(/^\s+model:\s*(.+)$/m);
  if (!m) return null;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v || null;
}

/** 首次接线前完整备份；绝不把网关 Key 当作用户官方 Key */
function backupDsh() {
  const bak = {
    hadDeepseekKey: false,
    deepseekApiKey: null,
    hadCordis: false,
    cordisSavedTo: null,
    previousDefaultModel: null,
  };
  const key = readDeepseekKeyFromCredentials();
  if (key && !isGatewayLocalKey(key)) {
    bak.hadDeepseekKey = true;
    bak.deepseekApiKey = key;
    saveOfficialDeepseek(key);
  } else if (key && isGatewayLocalKey(key)) {
    // 已被污染：不写入备份 Key；若已有外置官方 Key 则保留
    const existing = loadOfficialDeepseek();
    if (existing.apiKey) {
      bak.hadDeepseekKey = true;
      bak.deepseekApiKey = existing.apiKey;
    }
  } else {
    const existing = loadOfficialDeepseek();
    if (existing.apiKey) {
      bak.hadDeepseekKey = true;
      bak.deepseekApiKey = existing.apiKey;
    }
  }

  const cordisPath = dshCordisPatchPath();
  if (existsSync(cordisPath)) {
    const raw = readFileSync(cordisPath, "utf8");
    // 仅在尚无备份时保存「接线前」原文
    if (!existsSync(cordisBakPath())) {
      copyFileSync(cordisPath, cordisBakPath());
    }
    bak.hadCordis = true;
    bak.cordisSavedTo = DSH_CORDIS_BAK;
    bak.previousDefaultModel = parseDefaultModelFromCordis(stripDshCordisManaged(raw));
  }
  return bak;
}

function dshCordisPatchPath() {
  return join(dshHome(), "profiles", "web", "cordis.patch.yml");
}

function isTopLevelYamlItem(line) {
  return /^- /.test(line) || line.startsWith("#");
}

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

function modalitiesForModel(id) {
  if (id === LOGICAL_AUTO || id === LOGICAL_AUTO_VISION) {
    return ["text", "image"];
  }
  if (id === LOGICAL_AUTO_TEXT) return ["text"];
  const official = OFFICIAL_DEEPSEEK_MODELS.find((m) => m.id === id);
  if (official) return [...official.inputModalities];
  if (modelHasCapability(id, "image")) return ["text", "image"];
  return ["text"];
}

function buildMergedModelIds(gatewayModelIds, previousDefault) {
  const out = [];
  const push = (id) => {
    const s = String(id || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };
  // 仅在确有官方 Key 时注入官方模型，避免选择器里点了却 503
  if (hasOfficialDeepseekKey()) {
    for (const m of OFFICIAL_DEEPSEEK_MODELS) push(m.id);
  }
  for (const id of gatewayModelIds || []) {
    // 无官方 Key 时不要把官方 id 伪装成网关物理模型
    if (!hasOfficialDeepseekKey() && isOfficialDeepseekModel(id)) continue;
    push(id);
  }
  if (previousDefault) push(previousDefault);
  return out;
}

function killPidFile(pidFile) {
  if (!existsSync(pidFile)) return false;
  let pid = 0;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(pidFile);
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * 接线/恢复后必须重启 Agent 进程，否则会继续用旧 DEEPSEEK_BASE_URL / 旧 opencode.json。
 * 只杀进程；下次用户从 Ops 打开会按新配置拉起。
 */
function bounceAgentsAfterWire() {
  const notes = [];
  const dshRoot = join(agentsDir(), "dsh_agent");
  if (killPidFile(join(dshRoot, ".cizhenyu-web.pid"))) {
    try {
      unlinkSync(join(dshRoot, ".cizhenyu-web.url"));
    } catch {
      /* ignore */
    }
    notes.push("dsh-restart-required");
  }
  const ocHome = join(agentsDir(), "opencode_agent", "home");
  if (killPidFile(join(ocHome, ".cizhenyu-opencode.pid"))) {
    notes.push("opencode-restart-required");
  }
  return notes;
}

/**
 * 确保 DSH .credentials.yaml 可写：
 * - refs 必须是 mapping（`refs: {}` 或块映射），否则保存 Key 报
 *   Expected YAML collection at refs. Remaining path: DEEPSEEK_API_KEY
 * - stripGateway=true 时清掉 sk-cizhenyu-*（恢复官方 Key 前用）
 */
function ensureDshCredentialsShape({ stripGateway = false } = {}) {
  const path = join(dshHome(), ".credentials.yaml");
  mkdirSync(dirname(path), { recursive: true });
  let raw = existsSync(path)
    ? readFileSync(path, "utf8")
    : "version: 1\nrecords: {}\nrefs: {}\n";

  // 展开 inline：refs: { DEEPSEEK_API_KEY: xxx }
  raw = raw.replace(
    /^(\s*refs\s*:)\s*\{\s*DEEPSEEK_API_KEY\s*:\s*([^}\n]+)\s*\}\s*$/m,
    (_, head, val) => `${head}\n  DEEPSEEK_API_KEY: ${String(val).trim()}`,
  );
  raw = raw.replace(/^(\s*refs\s*:)\s*\{\s*\}\s*$/m, "$1 {}");

  const lines = raw.split(/\r?\n/).filter((line) => {
    if (!line.trim().startsWith("DEEPSEEK_API_KEY:")) return true;
    if (!stripGateway) return true;
    const val = line.replace(/^[^:]*:\s*/, "").trim().replace(/^"|"$/g, "");
    return !isGatewayLocalKey(val);
  });

  let text = lines.join("\n");
  if (!/^\s*refs\s*:/m.test(text)) {
    text = `${text.trimEnd()}\nrefs: {}\n`;
  } else {
    text = text.replace(/^(\s*refs\s*:)\s*$/m, "$1 {}");
    text = text.replace(/^(\s*refs\s*:)\s*\n(?=\S)/m, "$1 {}\n");
  }
  text = text.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  writeFileSync(path, text, "utf8");
}

function scrubGatewayKeyFromCredentials() {
  ensureDshCredentialsShape({ stripGateway: true });
}

/**
 * DSH 有 credentials 服务时，环境变量 DEEPSEEK_API_KEY 会被忽略；
 * resolveDeepSeekApiKey 只读凭据。接线必须把网关 localKey 写入 refs。
 */
function writeDshCredentialApiKey(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return;
  const path = join(dshHome(), ".credentials.yaml");
  mkdirSync(dirname(path), { recursive: true });
  let raw = existsSync(path)
    ? readFileSync(path, "utf8")
    : "version: 1\nrecords: {}\nrefs: {}\n";

  raw = raw.replace(
    /^(\s*refs\s*:)\s*\{\s*DEEPSEEK_API_KEY\s*:\s*[^}\n]+\s*\}\s*$/m,
    "$1 {}",
  );
  raw = raw.replace(/^(\s*refs\s*:)\s*\{\s*\}\s*$/m, "$1 {}");

  const lines = raw.split(/\r?\n/).filter((line) => !line.trim().startsWith("DEEPSEEK_API_KEY:"));
  let text = lines.join("\n");
  if (/^(\s*refs\s*:)\s*\{\s*\}\s*$/m.test(text)) {
    text = text.replace(/^(\s*refs\s*:)\s*\{\s*\}\s*$/m, `$1\n  DEEPSEEK_API_KEY: ${key}`);
  } else if (/^(\s*refs\s*:)\s*$/m.test(text)) {
    text = text.replace(/^(\s*refs\s*:)\s*$/m, `$1\n  DEEPSEEK_API_KEY: ${key}`);
  } else if (/^\s*refs\s*:/m.test(text)) {
    text = text.replace(/^(\s*refs\s*:)\s*/m, `$1\n  DEEPSEEK_API_KEY: ${key}\n`);
  } else {
    text = `${text.trimEnd()}\nrefs:\n  DEEPSEEK_API_KEY: ${key}\n`;
  }
  writeFileSync(path, text.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n", "utf8");
}

function applyDshCordis(dshBase, modelIds, previousDefault) {
  const path = dshCordisPatchPath();
  mkdirSync(dirname(path), { recursive: true });
  let raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  raw = stripDshCordisManaged(raw);
  const ids = buildMergedModelIds(modelIds, previousDefault);
  if (!ids.length) {
    writeFileSync(path, raw ? `${raw.trimEnd()}\n` : "", "utf8");
    return;
  }

  let defaultId = previousDefault;
  if (!defaultId || !ids.includes(defaultId) || isOfficialDeepseekModel(defaultId) === false) {
    // 若用户原默认是官方模型且仍在列表中，保留；否则偏好 auto
  }
  if (previousDefault && ids.includes(previousDefault)) {
    defaultId = previousDefault;
  } else if (ids.includes(LOGICAL_AUTO)) {
    defaultId = LOGICAL_AUTO;
  } else if (ids.includes(LOGICAL_AUTO_TEXT)) {
    defaultId = LOGICAL_AUTO_TEXT;
  } else {
    defaultId = ids[0];
  }

  const modelsYaml = ids
    .map((id) => {
      const mods = modalitiesForModel(id);
      const modYaml = mods.map((m) => `          - ${m}`).join("\n");
      const name =
        OFFICIAL_DEEPSEEK_MODELS.find((m) => m.id === id)?.name ||
        (id.startsWith("cizhenyu/auto") ? `${id}（自动）` : id);
      return `      - id: ${yamlQuote(id)}\n        name: ${yamlQuote(name)}\n        inputModalities:\n${modYaml}`;
    })
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

function restoreDshCordis(bak) {
  const path = dshCordisPatchPath();
  const bakFile = cordisBakPath();
  if (bak?.hadCordis && existsSync(bakFile)) {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(bakFile, path);
    try {
      unlinkSync(bakFile);
    } catch {
      /* ignore */
    }
    return;
  }
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

function applyDsh(localKey, dshBase, modelIds, bak) {
  const home = dshHome();
  mkdirSync(home, { recursive: true });

  // 接线前抢救官方 Key → official-deepseek.json（关网关时写回凭据）
  const current = readDeepseekKeyFromCredentials();
  if (current && !isGatewayLocalKey(current)) {
    saveOfficialDeepseek(current);
  } else if (bak?.deepseekApiKey && !isGatewayLocalKey(bak.deepseekApiKey)) {
    saveOfficialDeepseek(bak.deepseekApiKey);
  }

  // DSH credentials 服务优先于环境变量：必须把网关 Key 写入凭据，否则会拿官方 Key 打网关 → 401
  writeDshCredentialApiKey(localKey);

  // ops-env 仍写：BASE_URL 备用；无 credentials 服务的启动路径也能用 Key
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
  applyDshCordis(dshBase, modelIds, bak?.previousDefaultModel || null);
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
  restoreDshCordis(bak);

  // 接线时凭据里是网关 Key：先清掉，再写回官方 Key
  scrubGatewayKeyFromCredentials();
  const official = loadOfficialDeepseek();
  const restoreKey =
    bak?.deepseekApiKey && !isGatewayLocalKey(bak.deepseekApiKey)
      ? bak.deepseekApiKey
      : official.apiKey && !isGatewayLocalKey(official.apiKey)
        ? official.apiKey
        : null;
  if (restoreKey) writeDshCredentialApiKey(restoreKey);
  else ensureDshCredentialsShape({ stripGateway: true });
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
  const ids = [];
  const push = (id) => {
    const s = String(id || "").trim();
    if (!s || ids.includes(s)) return;
    // 无官方 Key 时不要注入官方 deepseek-*（会进网关却无上游）
    if (!hasOfficialDeepseekKey() && isOfficialDeepseekModel(s)) return;
    ids.push(s);
  };
  if (hasOfficialDeepseekKey()) {
    for (const m of OFFICIAL_DEEPSEEK_MODELS) push(m.id);
  }
  for (const id of modelIds || []) push(id);
  for (const id of ids) {
    models[id] = { name: id };
  }
  const preferred =
    (modelId && ids.includes(modelId) && modelId) ||
    ids.find((x) => x.startsWith("cizhenyu/auto")) ||
    ids[0] ||
    LOGICAL_AUTO;
  root.model = `${MANAGED_PROVIDER}/${preferred}`;
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
  const official = hasOfficialDeepseekKey();
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
            return Boolean(
              v?.provider?.[MANAGED_PROVIDER] ||
                String(v?.model || "").startsWith(`${MANAGED_PROVIDER}/`),
            );
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
    officialDeepseek: official,
    upstreamCount: (cfg.connections || []).filter(
      (c) => c.enabled !== false && String(c.apiKey || "").trim(),
    ).length,
    note: "接线后 DSH 凭据会临时换成网关 Key（官方 Key 已备份）；停服务后写回。日常推荐 cizhenyu/auto。",
  };
}

export function applyOnGatewayUp() {
  const ep = readEndpoint();
  const st = loadState();
  if (!st.active) {
    st.dsh = dshInstalled() ? backupDsh() : null;
    st.opencode = opencodeInstalled() ? backupOpencode() : null;
  } else if (dshInstalled()) {
    // 已接线时仍尝试抢救官方 Key
    const cur = readDeepseekKeyFromCredentials();
    if (cur && !isGatewayLocalKey(cur)) saveOfficialDeepseek(cur);
    if (!st.dsh) st.dsh = backupDsh();
  }
  const errors = [];
  if (dshInstalled()) {
    try {
      applyDsh(ep.key, ep.dshBase, ep.models, st.dsh);
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
  const bounced = bounceAgentsAfterWire();
  st.bounced = bounced;
  saveState(st);
  return {
    ...st,
    ...wireStatus(),
    errors,
    bounced,
    note:
      bounced.length > 0
        ? "已更新接线并重启 Agent 进程。请从运营页重新打开 DSH / OpenCode。"
        : "已更新接线。若 Agent 已在运行，请关闭后重新打开以使环境变量生效。",
  };
}

export function restoreOnGatewayDown() {
  const st = loadState();
  if (!st.active) {
    // 即使状态未标记 active，也清掉残留 ops-env / 网关 Key，并尝试 bounce
    scrubGatewayKeyFromCredentials();
    try {
      unlinkSync(join(dshHome(), DSH_OPS_ENV));
    } catch {
      /* ignore */
    }
    const bounced = bounceAgentsAfterWire();
    return { ...st, ...wireStatus(), bounced };
  }
  if (st.dsh) restoreDsh(st.dsh);
  else {
    scrubGatewayKeyFromCredentials();
    try {
      unlinkSync(join(dshHome(), DSH_OPS_ENV));
    } catch {
      /* ignore */
    }
  }
  if (st.opencode) restoreOpencode(st.opencode);
  st.active = false;
  st.errors = [];
  const bounced = bounceAgentsAfterWire();
  st.bounced = bounced;
  saveState(st);
  return {
    ...st,
    ...wireStatus(),
    bounced,
    note:
      bounced.length > 0
        ? "已恢复 Agent 配置并重启进程。请从运营页重新打开；DSH 请重新填写/确认官方 DeepSeek Key。"
        : "已恢复 Agent 配置。请重新打开 Agent；若 DSH 无法聊天，请在设置中重新保存官方 DeepSeek Key。",
  };
}

export function reconcileIfStale(gatewayRunning) {
  const st = loadState();
  if (st.active && !gatewayRunning) {
    restoreOnGatewayDown();
  }
}
