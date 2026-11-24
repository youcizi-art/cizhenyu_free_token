const $ = (id) => document.getElementById(id);

let catalog = { providers: [] };
let config = null;
let tierFilter = "all";

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function tierLabel(t) {
  return ({ free: "免费", trial: "试用", cheap: "廉价", paid: "付费" }[t] || t);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function connectedCount(providerId) {
  return (config?.connections || []).filter((c) => c.providerId === providerId && c.hasApiKey).length;
}

function renderWire(wire) {
  const badge = $("wireBadge");
  const list = $("statusList");
  if (!wire) {
    badge.textContent = "未知";
    badge.className = "badge";
    return;
  }
  const ok = wire.active && (wire.models || []).length > 0;
  badge.textContent = ok ? `已接线 · ${(wire.models || []).length} 模型` : wire.active ? "已启动，待连接商家" : "未接线";
  badge.className = ok ? "badge ok" : "badge";
  const rows = [
    `可用连接：${wire.upstreamCount ?? (config?.connections || []).filter((c) => c.enabled && c.hasApiKey).length}`,
    `注入模型：${(wire.models || []).join("、") || "无"}`,
    `默认模型：${wire.defaultModel || "未设"}`,
    `DSH：${wire.dshInstalled ? (wire.dshWired ? "已改写" : "未接线") : "未安装"}`,
    `OpenCode：${wire.opencodeInstalled ? (wire.opencodeWired ? "已改写" : "未接线") : "未安装"}`,
  ];
  list.innerHTML = rows.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
}

function renderRoute(stats) {
  const list = $("routeList");
  if (!list) return;
  if (!stats) {
    list.innerHTML = "<li>加载中…</li>";
    return;
  }
  const samples = (stats.sampleText || [])
    .map((s) => `${s.label}/${s.model}`)
    .join("；");
  const rows = [
    `逻辑默认：${stats.autoText || "cizhenyu/auto-text"}`,
    `生效默认：${config?.effectiveDefaultModel || stats.effectiveDefaultModel || "—"}`,
    `文本候选：${stats.textCandidates ?? 0}`,
    `视觉候选：${stats.visionCandidates ?? 0}`,
    `冷却中连接：${stats.coolingConnections ?? 0}；冷却中模型：${stats.coolingModels ?? 0}`,
    samples ? `文本池示例：${samples}` : "文本池为空：请先连接商家",
  ];
  list.innerHTML = rows.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
}

async function openExternal(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return;
  try {
    const res = await fetch("/api/open-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: u }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "open failed");
    toast("已在系统浏览器打开");
  } catch (e) {
    try {
      await navigator.clipboard.writeText(u);
      toast("无法自动打开，链接已复制到剪贴板");
    } catch {
      toast(`请手动打开：${u}`);
    }
  }
}

function renderCatalog() {
  const root = $("catalogList");
  const list = (catalog.providers || []).filter((p) => tierFilter === "all" || p.tier === tierFilter);
  if (!list.length) {
    root.innerHTML = '<div class="empty">该分类下暂无商家</div>';
    return;
  }
  root.innerHTML = list
    .map((p) => {
      const n = connectedCount(p.id);
      const models = p.models || [];
      const preview = models.slice(0, 4).map(escapeHtml).join(", ") || "连接时自行填写模型";
      const more =
        models.length > 4
          ? `<details class="model-more"><summary>全部 ${models.length} 个模型</summary><ul>${models
              .map((m) => `<li><code>${escapeHtml(m)}</code></li>`)
              .join("")}</ul></details>`
          : models.length
            ? `<p class="models"><strong>模型：</strong>${preview}</p>`
            : `<p class="models"><strong>模型：</strong>连接时自行填写</p>`;
      return `
      <article class="provider-card" data-id="${escapeHtml(p.id)}">
        <span class="tier ${escapeHtml(p.tier)}">${tierLabel(p.tier)}</span>
        <h3>${escapeHtml(p.name)}</h3>
        <p>${escapeHtml(p.notes || "")}</p>
        ${models.length > 4 ? `<p class="models"><strong>模型：</strong>${preview} …</p>${more}` : more}
        <p class="muted small">${escapeHtml(p.quotaHint || "")}${n ? ` · 已连接 ${n}` : ""}</p>
        <div class="row">
          ${
            p.signupUrl
              ? `<button type="button" class="btn" data-open="${escapeHtml(p.signupUrl)}">去注册</button>`
              : ""
          }
          ${
            p.docsUrl
              ? `<button type="button" class="btn ghost" data-open="${escapeHtml(p.docsUrl)}">文档</button>`
              : ""
          }
          <button type="button" class="btn primary" data-connect="${escapeHtml(p.id)}">填入密钥</button>
        </div>
      </article>`;
    })
    .join("");

  root.querySelectorAll("[data-connect]").forEach((btn) => {
    btn.addEventListener("click", () => openConnect(btn.getAttribute("data-connect")));
  });
  root.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => openExternal(btn.getAttribute("data-open")));
  });
}

function renderConnections() {
  const root = $("connList");
  const list = config?.connections || [];
  if (!list.length) {
    root.innerHTML =
      '<div class="empty">还没有连接。请到「商家目录」注册并填入密钥。</div>';
    return;
  }
  root.innerHTML = list
    .map((c) => {
      const cooling = c.cooling ? " · 冷却中" : "";
      return `
      <article class="conn-card">
        <div class="top">
          <div>
            <strong>${escapeHtml(c.label)}</strong>
            <span class="tier ${escapeHtml(c.tier)}">${tierLabel(c.tier)}</span>
          </div>
          <button type="button" class="btn danger" data-del="${escapeHtml(c.id)}">删除</button>
        </div>
        <div class="conn-meta">
          商家：${escapeHtml(c.providerId)} · 优先级 ${c.priority}
          ${c.enabled === false ? " · 已停用" : " · 启用"}${cooling}<br/>
          ${escapeHtml(c.baseUrl)}<br/>
          模型：${escapeHtml((c.models || []).join(", ") || "未设")} · Key：${c.hasApiKey ? "已保存" : "缺失"}
        </div>
        <label class="check">
          <input type="checkbox" data-en="${escapeHtml(c.id)}" ${c.enabled !== false ? "checked" : ""} />
          参与轮换
        </label>
      </article>`;
    })
    .join("");

  root.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      const res = await fetch(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      applyConfigPayload(data);
      toast("已删除连接");
    });
  });
  root.querySelectorAll("[data-en]").forEach((input) => {
    input.addEventListener("change", async () => {
      const id = input.getAttribute("data-en");
      const conn = (config.connections || []).find((c) => c.id === id);
      if (!conn) return;
      const body = {
        ...config,
        connections: config.connections.map((c) =>
          c.id === id ? { ...c, enabled: input.checked, apiKey: "" } : { ...c, apiKey: "" },
        ),
      };
      // 保留密钥：服务端用空 apiKey 表示不改；但我们需要带 enabled
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultModel: config.defaultModel,
          strategy: config.strategy,
          connections: config.connections.map((c) => ({
            ...c,
            enabled: c.id === id ? input.checked : c.enabled,
            apiKey: "",
          })),
        }),
      });
      applyConfigPayload(await res.json());
      toast("已更新");
    });
  });
}

function fillStrategy() {
  $("strategyMode").value = config.strategy?.mode || "priority";
  $("preferFree").checked = config.strategy?.preferFree !== false;
  $("cooldownSeconds").value = config.strategy?.cooldownSeconds || 120;
  if ($("modelCooldownSeconds")) {
    $("modelCooldownSeconds").value = config.strategy?.modelCooldownSeconds || 300;
  }
  if ($("injectPhysicalModels")) {
    $("injectPhysicalModels").checked = Boolean(config.strategy?.injectPhysicalModels);
  }
  $("port").value = config.port;
  $("localApiKey").value = config.localApiKey || "";
  const models = [...(config.injectedModels || [])];
  if (!models.length) {
    for (const c of config.connections || []) {
      if (!c.enabled || !c.hasApiKey) continue;
      for (const m of c.models || []) if (m && !models.includes(m)) models.push(m);
    }
  }
  const preferred = config.defaultModel || config.effectiveDefaultModel || "cizhenyu/auto-text";
  const sel = $("defaultModel");
  sel.innerHTML = "";
  if (!models.length) {
    const o = document.createElement("option");
    o.value = "cizhenyu/auto-text";
    o.textContent = "cizhenyu/auto-text（连接商家后生效）";
    sel.appendChild(o);
  } else {
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m.startsWith("cizhenyu/auto") ? `${m}（自动轮换）` : m;
      if (m === preferred) o.selected = true;
      sel.appendChild(o);
    }
  }
}

function wireFromPayload(data) {
  if (!data) return null;
  if (data.wire?.wire) return data.wire.wire;
  if (data.wire && (data.wire.active != null || data.wire.models)) return data.wire;
  return data;
}

function applyConfigPayload(data) {
  config = data;
  renderWire(wireFromPayload(data));
  renderCatalog();
  renderConnections();
  fillStrategy();
  void refreshRoute();
}

async function refreshRoute() {
  try {
    const stats = await fetch("/api/route-status").then((r) => r.json());
    renderRoute(stats);
  } catch {
    renderRoute(null);
  }
}

function openConnect(providerId) {
  const p = (catalog.providers || []).find((x) => x.id === providerId);
  if (!p) return;
  $("connProviderId").value = p.id;
  $("connectTitle").textContent = `连接 ${p.name}`;
  $("connectHint").textContent = p.signupUrl
    ? "若尚未注册，请先点卡片上的「去注册」，拿到 Key 后再粘贴到这里。"
    : "填写自定义 OpenAI 兼容地址与密钥。";
  $("connLabel").value = p.name;
  $("connBaseUrl").value = p.baseUrl || "";
  $("baseUrlField").style.display = p.id === "custom" || !p.baseUrl ? "block" : "block";
  $("connApiKey").value = "";
  $("connModels").value = (p.models || []).join(", ");
  $("connPriority").value = p.tier === "free" ? 10 : p.tier === "trial" ? 20 : 30;
  $("connectDialog").showModal();
}

async function load() {
  const [cat, cfg] = await Promise.all([
    fetch("/api/catalog").then((r) => r.json()),
    fetch("/api/config").then((r) => r.json()),
  ]);
  catalog = cat;
  applyConfigPayload(cfg);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    tierFilter = chip.dataset.tier;
    renderCatalog();
  });
});

$("btnConnectCancel").addEventListener("click", () => $("connectDialog").close());

$("connectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const providerId = $("connProviderId").value;
  const models = $("connModels").value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const res = await fetch("/api/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId,
      label: $("connLabel").value.trim(),
      baseUrl: $("connBaseUrl").value.trim(),
      apiKey: $("connApiKey").value.trim(),
      models,
      priority: Number($("connPriority").value) || 10,
      enabled: true,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || "保存失败");
    return;
  }
  $("connectDialog").close();
  applyConfigPayload(data);
  toast("已连接。请到「我的连接 / 策略」确认，并重新打开 Agent。");
  document.querySelector('.tab[data-tab="connections"]').click();
});

$("btnSaveStrategy").addEventListener("click", async () => {
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      defaultModel: $("defaultModel").value || "cizhenyu/auto-text",
      strategy: {
        modelCooldownSeconds: Number($("modelCooldownSeconds")?.value) || 300,
        injectPhysicalModels: Boolean($("injectPhysicalModels")?.checked),
        maxAttemptsPerRequest: 5,
        remapOnModelError: true,
        mode: $("strategyMode").value,
        preferFree: $("preferFree").checked,
        cooldownSeconds: Number($("cooldownSeconds").value) || 120,
      },
      connections: (config.connections || []).map((c) => ({ ...c, apiKey: "" })),
    }),
  });
  applyConfigPayload(await res.json());
  toast("策略已保存并尝试重新接线");
});

$("btnSaveAdvanced").addEventListener("click", async () => {
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      port: Number($("port").value),
      defaultModel: config.defaultModel,
      strategy: config.strategy,
      connections: (config.connections || []).map((c) => ({ ...c, apiKey: "" })),
    }),
  });
  applyConfigPayload(await res.json());
  toast("高级设置已保存（改端口需重启服务）");
});

$("btnRewire").addEventListener("click", async () => {
  const data = await fetch("/api/wire/apply", { method: "POST" }).then((r) => r.json());
  renderWire(data.wire || data);
  toast(data.ok === false ? `接线失败：${data.error}` : "已重新接线");
});

$("btnCopyKey").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("localApiKey").value);
  toast("已复制网关本地 Key");
});

load().catch((e) => toast(String(e)));
