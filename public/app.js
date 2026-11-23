const $ = (id) => document.getElementById(id);

function uid() {
  return `up-${Math.random().toString(16).slice(2, 10)}`;
}

let state = null;

function renderUpstreams() {
  const root = $("upstreams");
  root.innerHTML = "";
  for (const u of state.upstreams || []) {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="top">
        <strong>${escapeHtml(u.name || u.id)}</strong>
        <button type="button" class="ghost danger" data-rm="${escapeHtml(u.id)}">删除</button>
      </div>
      <label>名称<input data-f="name" data-id="${escapeHtml(u.id)}" value="${escapeAttr(u.name || "")}" /></label>
      <label>Base URL<input data-f="baseUrl" data-id="${escapeHtml(u.id)}" value="${escapeAttr(u.baseUrl || "")}" placeholder="https://api.openai.com/v1" /></label>
      <label>API Key<input data-f="apiKey" data-id="${escapeHtml(u.id)}" type="password" placeholder="${u.hasApiKey ? "(已保存，留空则不变)" : "上游密钥"}" /></label>
      <label>模型列表（逗号分隔）<input data-f="models" data-id="${escapeHtml(u.id)}" value="${escapeAttr((u.models || []).join(", "))}" /></label>
      <label class="check"><input type="checkbox" data-f="enabled" data-id="${escapeHtml(u.id)}" ${u.enabled !== false ? "checked" : ""} /> 启用</label>
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

function collectFromDom() {
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
  return next;
}

function updateHints() {
  const port = Number($("port").value) || state.port;
  $("endpointHint").textContent =
    `Agent Base URL: http://127.0.0.1:${port}/v1 · UI: http://127.0.0.1:${port}/`;
}

async function load() {
  const res = await fetch("/api/config");
  state = await res.json();
  $("port").value = state.port;
  $("defaultModel").value = state.defaultModel || "";
  $("localApiKey").value = state.localApiKey || "";
  renderUpstreams();
  updateHints();
}

$("btnAdd").addEventListener("click", () => {
  state.upstreams = state.upstreams || [];
  state.upstreams.push({
    id: uid(),
    name: "New upstream",
    baseUrl: "https://api.openai.com/v1",
    models: [],
    enabled: true,
    hasApiKey: false,
  });
  renderUpstreams();
});

$("btnSave").addEventListener("click", async () => {
  const body = collectFromDom();
  $("status").textContent = "保存中…";
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    $("status").textContent = "保存失败";
    return;
  }
  state = await res.json();
  $("localApiKey").value = state.localApiKey;
  renderUpstreams();
  updateHints();
  $("status").textContent = "已保存（若改端口需重启网关进程）";
});

$("btnRotate").addEventListener("click", async () => {
  const body = collectFromDom();
  body.rotateLocalKey = true;
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  state = await res.json();
  $("localApiKey").value = state.localApiKey;
  $("status").textContent = "已轮换本地 Key（请重新启用 Agent 接线）";
});

$("btnCopyKey").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("localApiKey").value);
  $("status").textContent = "已复制本地 API Key";
});

$("btnImportCms").addEventListener("click", async () => {
  let payload;
  try {
    payload = JSON.parse($("cmsJson").value || "{}");
  } catch {
    $("status").textContent = "JSON 无效";
    return;
  }
  const res = await fetch("/api/import-cms-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    $("status").textContent = data.error || "导入失败";
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
  $("status").textContent = `已加入 ${data.upstreams?.length || 0} 条上游预览，请检查后保存`;
});

$("port").addEventListener("input", updateHints);

load().catch((e) => {
  $("status").textContent = String(e);
});
