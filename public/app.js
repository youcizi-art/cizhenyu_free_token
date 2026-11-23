const $ = (id) => document.getElementById(id);

function uid() {
  return `up-${Math.random().toString(16).slice(2, 10)}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;");
}

let state = null;

function allModelIds() {
  const out = [];
  for (const u of state.upstreams || []) {
    if (u.enabled === false) continue;
    for (const m of u.models || []) {
      if (m && !out.includes(m)) out.push(m);
    }
  }
  return out;
}

function renderDefaultModel() {
  const sel = $("defaultModel");
  const models = allModelIds();
  const cur = state.defaultModel || models[0] || "";
  sel.innerHTML = "";
  if (!models.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "请先在上游中填写模型 id";
    sel.appendChild(opt);
    return;
  }
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    if (m === cur) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderWire(wire) {
  const badge = $("wireBadge");
  const list = $("statusList");
  const tip = $("statusTip");
  if (!wire) {
    badge.textContent = "状态未知";
    badge.className = "badge";
    list.innerHTML = "";
    return;
  }
  const ready =
    wire.active &&
    (wire.models || []).length > 0 &&
    wire.upstreamCount > 0 &&
    (wire.dshWired || wire.opencodeWired || (!wire.dshInstalled && !wire.opencodeInstalled));
  badge.textContent = wire.active ? (ready ? "已接线" : "已启动，待完善") : "未接线";
  badge.className = wire.active && ready ? "badge ok" : "badge";

  const rows = [
    `网关端口：${wire.gatewayPort}`,
    `上游数量：${wire.upstreamCount}`,
    `可用模型：${(wire.models || []).join("、") || "无"}`,
    `默认模型：${wire.defaultModel || "未设置"}`,
    `DSH：${wire.dshInstalled ? (wire.dshWired ? "已改写模型入口" : "已安装但未接线") : "未安装"}`,
    `OpenCode：${wire.opencodeInstalled ? (wire.opencodeWired ? "已改写模型入口" : "已安装但未接线") : "未安装"}`,
  ];
  list.innerHTML = rows.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
  tip.textContent =
    wire.note ||
    "改写配置后请重新打开 DSH / OpenCode，正在运行的窗口不会自动切换模型。";
}

function renderUpstreams() {
  const root = $("upstreams");
  root.innerHTML = "";
  const list = state.upstreams || [];
  if (!list.length) {
    root.innerHTML =
      '<div class="empty">还没有上游。点击「添加上游」，填入你的 API 地址、密钥和模型名称。</div>';
    renderDefaultModel();
    return;
  }
  for (const u of list) {
    const el = document.createElement("div");
    el.className = "upstream";
    el.innerHTML = `
      <div class="upstream-top">
        <strong>${escapeHtml(u.name || "未命名上游")}</strong>
        <button type="button" class="btn danger" data-rm="${escapeAttr(u.id)}">删除</button>
      </div>
      <label class="field">
        <span>显示名称（方便你识别，例如「DeepSeek」「OpenAI」）</span>
        <input data-f="name" data-id="${escapeAttr(u.id)}" value="${escapeAttr(u.name || "")}" placeholder="例如 DeepSeek" />
      </label>
      <label class="field">
        <span>接口地址 Base URL（OpenAI 兼容，通常以 /v1 结尾）</span>
        <input data-f="baseUrl" data-id="${escapeAttr(u.id)}" value="${escapeAttr(u.baseUrl || "")}" placeholder="https://api.deepseek.com/v1" />
        <p class="field-hint">常见示例：https://api.openai.com/v1 、 https://api.deepseek.com/v1</p>
      </label>
      <label class="field">
        <span>上游 API Key（你的真实密钥，只保存在本机网关）</span>
        <input data-f="apiKey" data-id="${escapeAttr(u.id)}" type="password" placeholder="${u.hasApiKey ? "已保存，留空表示不修改" : "sk-…"}" autocomplete="off" />
      </label>
      <label class="field">
        <span>模型 id 列表（逗号分隔，必须是上游真实支持的模型名）</span>
        <input data-f="models" data-id="${escapeAttr(u.id)}" value="${escapeAttr((u.models || []).join(", "))}" placeholder="例如 deepseek-chat, deepseek-reasoner" />
        <p class="field-hint">不要填「default」。Agent 里看到的模型名就是这里填的 id。</p>
      </label>
      <label class="check">
        <input type="checkbox" data-f="enabled" data-id="${escapeAttr(u.id)}" ${u.enabled !== false ? "checked" : ""} />
        启用这条上游
      </label>
    `;
    root.appendChild(el);
  }
  root.querySelectorAll("[data-rm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-rm");
      state.upstreams = state.upstreams.filter((x) => x.id !== id);
      renderUpstreams();
    });
  });
  root.querySelectorAll('[data-f="models"]').forEach((input) => {
    input.addEventListener("input", () => {
      collectFromDom(false);
      renderDefaultModel();
    });
  });
  renderDefaultModel();
}

function collectFromDom(writeBack = true) {
  const next = structuredClone(state);
  next.port = Number($("port").value) || next.port;
  next.defaultModel = $("defaultModel").value.trim();
  next.localApiKey = $("localApiKey").value.trim();
  const map = new Map((next.upstreams || []).map((u) => [u.id, { ...u }]));
  document.querySelectorAll("[data-f][data-id]").forEach((input) => {
    const id = input.getAttribute("data-id");
    const f = input.getAttribute("data-f");
    const u = map.get(id);
    if (!u) return;
    if (f === "enabled") u.enabled = input.checked;
    else if (f === "models") {
      u.models = String(input.value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    } else if (f === "apiKey") {
      if (input.value) u.apiKey = input.value;
      else delete u.apiKey;
    } else {
      u[f] = input.value;
    }
  });
  next.upstreams = [...map.values()];
  if (writeBack) state = next;
  return next;
}

function setStatus(msg) {
  $("status").textContent = msg || "";
}

async function load() {
  const res = await fetch("/api/config");
  state = await res.json();
  $("port").value = state.port;
  $("localApiKey").value = state.localApiKey || "";
  renderUpstreams();
  renderWire(state.wire);
}

$("btnAdd").addEventListener("click", () => {
  state.upstreams = state.upstreams || [];
  state.upstreams.push({
    id: uid(),
    name: "我的上游",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat"],
    enabled: true,
    hasApiKey: false,
  });
  renderUpstreams();
});

$("btnSave").addEventListener("click", async () => {
  const body = collectFromDom(true);
  if (!(body.upstreams || []).some((u) => u.enabled !== false && (u.models || []).length)) {
    setStatus("请至少启用一条上游，并填写模型 id");
    return;
  }
  setStatus("保存中…");
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || "保存失败");
    return;
  }
  state = data;
  $("localApiKey").value = state.localApiKey || "";
  renderUpstreams();
  const wire = data.wire?.wire || data.wire;
  renderWire(wire);
  if (data.wire?.ok === false) {
    setStatus(`已保存，但接线失败：${data.wire.error}`);
  } else {
    setStatus("已保存并应用到 Agent。请重新打开 DSH / OpenCode。");
  }
});

$("btnRewire").addEventListener("click", async () => {
  setStatus("重新接线…");
  const res = await fetch("/api/wire/apply", { method: "POST" });
  const data = await res.json();
  renderWire(data.wire || data);
  setStatus(data.ok === false ? `接线失败：${data.error}` : "已重新接线。请重新打开 Agent。");
});

$("btnRotate").addEventListener("click", async () => {
  const body = collectFromDom(true);
  body.rotateLocalKey = true;
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  state = await res.json();
  $("localApiKey").value = state.localApiKey || "";
  renderWire(state.wire?.wire || state.wire);
  setStatus("已轮换本地 Key，并重新接线");
});

$("btnCopyKey").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("localApiKey").value);
  setStatus("已复制本地 Key");
});

$("btnImportCms").addEventListener("click", async () => {
  let payload;
  try {
    payload = JSON.parse($("cmsJson").value || "{}");
  } catch {
    setStatus("JSON 无效");
    return;
  }
  const res = await fetch("/api/import-cms-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || "导入失败");
    return;
  }
  for (const u of data.upstreams || []) {
    state.upstreams.push({
      ...u,
      id: uid(),
      hasApiKey: Boolean(u.apiKey),
    });
  }
  renderUpstreams();
  setStatus(`已加入 ${data.upstreams?.length || 0} 条上游，请检查密钥后保存`);
});

load().catch((e) => setStatus(String(e)));
