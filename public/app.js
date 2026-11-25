const $ = (id) => document.getElementById(id);

let catalog = { providers: [] };
let config = null;
let tierFilter = "all";
let lastRouteStats = null;

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
  return (
    { free: "免费", trial: "试用", cheap: "廉价", paid: "付费", custom: "自定义" }[t] || t
  );
}

function providerTiers(p) {
  if (Array.isArray(p?.tiers) && p.tiers.length) return p.tiers.map(String);
  return p?.tier ? [String(p.tier)] : ["paid"];
}

function providerMatchesFilter(p) {
  if (tierFilter === "all") return true;
  return providerTiers(p).includes(tierFilter);
}

function tierBadgesHtml(p) {
  return `<div class="tier-row">${providerTiers(p)
    .map((t) => `<span class="tier ${escapeHtml(t)}">${tierLabel(t)}</span>`)
    .join("")}</div>`;
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

function fmtAgo(ts) {
  const n = Number(ts);
  if (!n) return "";
  const sec = Math.max(0, Math.round((Date.now() - n) / 1000));
  if (sec < 60) return `${sec}s 前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m 前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h 前`;
  return new Date(n).toLocaleString();
}

function kvItem(k, v) {
  return `<li><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></li>`;
}

function renderWire(wire) {
  const badge = $("wireBadge");
  const list = $("statusList");
  if (!wire) {
    badge.textContent = "未知";
    badge.className = "badge";
    if (list) list.innerHTML = kvItem("状态", "无法读取接线信息");
    return;
  }
  const ok = wire.active && (wire.models || []).length > 0;
  badge.textContent = ok
    ? `已接线 · ${(wire.models || []).length} 模型`
    : wire.active
      ? "已启动，待连接商家"
      : "未接线";
  badge.className = ok ? "badge ok" : "badge";

  const upstreamCount =
    wire.upstreamCount ?? (config?.connections || []).filter((c) => c.enabled && c.hasApiKey).length;
  if (!list) return;
  list.innerHTML = [
    kvItem("可用连接", String(upstreamCount)),
    kvItem("注入模型", (wire.models || []).join("、") || "无"),
    kvItem("默认模型", wire.defaultModel || "未设"),
    kvItem("官方 DeepSeek", wire.officialDeepseek ? "已备份可转发" : "未备份"),
    kvItem("DSH", wire.dshInstalled ? (wire.dshWired ? "已改写" : "未接线") : "未安装"),
    kvItem("OpenCode", wire.opencodeInstalled ? (wire.opencodeWired ? "已改写" : "未安装") : "未安装"),
  ].join("");
}

function renderStatStrip(stats) {
  const root = $("statStrip");
  if (!root) return;
  const last = stats?.lastSuccess;
  const lastValue = last
    ? `${last.label || last.providerId || "上游"}`
    : "—";
  const lastHint = last
    ? `${last.model || ""}${last.at ? ` · ${fmtAgo(last.at)}` : ""}`
    : "发一次聊天后出现";
  root.innerHTML = `
    <div class="stat-tile accent">
      <p class="label">最近成功</p>
      <p class="value">${escapeHtml(lastValue)}</p>
      <p class="hint">${escapeHtml(lastHint)}</p>
    </div>
    <div class="stat-tile">
      <p class="label">文本候选</p>
      <p class="value">${stats?.textCandidates ?? 0}</p>
      <p class="hint">${escapeHtml(stats?.auto || "cizhenyu/auto")} · 自动分流</p>
    </div>
    <div class="stat-tile">
      <p class="label">视觉候选</p>
      <p class="value">${stats?.visionCandidates ?? 0}</p>
      <p class="hint">${
        (stats?.visionCandidates ?? 0) > 0 || stats?.officialDeepseek
          ? escapeHtml(stats?.autoVision || "cizhenyu/auto-vision")
          : "无 VL 时不注入"
      }</p>
    </div>
    <div class="stat-tile">
      <p class="label">官方 / 冷却</p>
      <p class="value">${stats?.officialDeepseek ? "可转发" : "—"}</p>
      <p class="hint">冷却 连接 ${stats?.coolingConnections ?? 0} · 模型 ${stats?.coolingModels ?? 0}</p>
    </div>
  `;
}

function renderRoute(stats) {
  lastRouteStats = stats;
  renderStatStrip(stats);
  const panel = $("routePanel");
  if (!panel) return;
  if (!stats) {
    panel.innerHTML = '<p class="muted small">路由状态加载中…</p>';
    return;
  }

  const samples = (stats.sampleText || [])
    .map((s) => `<span class="pill muted">${escapeHtml(`${s.label}/${s.model}`)}</span>`)
    .join("");
  const visionSamples = (stats.sampleVision || [])
    .map((s) => `<span class="pill muted">${escapeHtml(`${s.label}/${s.model}`)}</span>`)
    .join("");
  const coolChips = (stats.coolingModels || [])
    .slice(0, 8)
    .map(
      (c) =>
        `<span class="pill warn">${escapeHtml(`${c.label}/${c.model}`)} · ${c.remainSec}s</span>`,
    )
    .join("");

  const rates = (stats.byKey || []).slice(0, 6);
  const rateHtml = rates.length
    ? `<div class="rate-bars">${rates
        .map((r) => {
          const pct = Math.max(0, Math.min(100, Number(r.rate) || 0));
          return `<div class="rate-row">
            <span class="name">${escapeHtml(`${r.label}/${r.model}`)}</span>
            <span class="pct">${pct}%</span>
            <div class="rate-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
          </div>`;
        })
        .join("")}</div>`
    : '<p class="muted small">暂无成功率样本</p>';

  panel.innerHTML = `
    <div class="route-block">
      <h3>生效默认</h3>
      <div class="chip-row">
        <span class="pill ok">${escapeHtml(
          config?.effectiveDefaultModel || stats.effectiveDefaultModel || "—",
        )}</span>
        ${
          stats.officialDeepseek
            ? '<span class="pill ok">官方 DeepSeek 可转发</span>'
            : '<span class="pill muted">官方 DeepSeek 未备份</span>'
        }
      </div>
    </div>
    <div class="route-block">
      <h3>文本池示例</h3>
      <div class="chip-row">${samples || '<span class="pill muted">空：请先连接商家</span>'}</div>
    </div>
    <div class="route-block">
      <h3>视觉池示例</h3>
      <div class="chip-row">${
        visionSamples || '<span class="pill muted">空：连接 VL / Vision 模型后出现</span>'
      }</div>
    </div>
    ${
      coolChips
        ? `<div class="route-block"><h3>模型冷却</h3><div class="chip-row">${coolChips}</div></div>`
        : ""
    }
    <div class="route-block">
      <h3>成功率</h3>
      ${rateHtml}
    </div>
  `;
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
  } catch {
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
  const list = (catalog.providers || []).filter(providerMatchesFilter);
  if (!list.length) {
    root.innerHTML = '<div class="empty"><strong>暂无商家</strong>换一个档位再看看，或点右上角「添加」</div>';
    return;
  }
  root.innerHTML = list
    .map((p) => {
      const n = connectedCount(p.id);
      const models = p.models || [];
      const preview = models.slice(0, 3).map(escapeHtml).join(", ") || "连接时自行填写";
      const more =
        models.length > 3
          ? `<details class="model-more"><summary>全部 ${models.length} 个模型</summary><ul>${models
              .map((m) => `<li><code>${escapeHtml(m)}</code></li>`)
              .join("")}</ul></details>`
          : "";
      return `
      <article class="provider-card" data-id="${escapeHtml(p.id)}">
        ${tierBadgesHtml(p)}
        <h3>${escapeHtml(p.name)}</h3>
        <p>${escapeHtml(p.notes || "")}</p>
        <p class="models"><strong>模型</strong> · ${preview}${models.length > 3 ? " …" : ""}</p>
        ${more}
        <p class="muted small">${escapeHtml(p.quotaHint || "")}</p>
        ${n ? `<p class="conn-count">已连接 ${n}</p>` : ""}
        <div class="row card-actions">
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
          ${
            p.custom
              ? `<button type="button" class="btn ghost" data-edit-prov="${escapeHtml(p.id)}">编辑</button>
                 <button type="button" class="btn danger ghost" data-del-prov="${escapeHtml(p.id)}">删除</button>`
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
  root.querySelectorAll("[data-edit-prov]").forEach((btn) => {
    btn.addEventListener("click", () => openProviderDialog(btn.getAttribute("data-edit-prov")));
  });
  root.querySelectorAll("[data-del-prov]").forEach((btn) => {
    btn.addEventListener("click", () => deleteCustomProvider(btn.getAttribute("data-del-prov")));
  });
}

function renderConnections() {
  const root = $("connList");
  const list = config?.connections || [];
  if (!list.length) {
    root.innerHTML =
      '<div class="empty"><strong>还没有连接</strong>到「商家目录」注册并填入密钥</div>';
    return;
  }
  root.innerHTML = list
    .map((c) => {
      const on = c.enabled !== false;
      const cooling = Boolean(c.cooling);
      const caps = (c.capabilities || []).join(" · ") || "text";
      const modelsPreview = (c.models || []).slice(0, 4).join(", ") || "未设";
      const moreModels = (c.models || []).length > 4 ? ` 等 ${(c.models || []).length} 个` : "";
      const coolModels = (c.coolingModels || [])
        .map((m) => {
          const sec = Math.max(0, Math.ceil((Number(m.until) - Date.now()) / 1000));
          return `${m.id} ${sec}s`;
        })
        .join(" · ");
      return `
      <article class="conn-card ${on ? "" : "is-off"} ${cooling ? "is-cooling" : ""}">
        <div class="conn-card-head">
          <h3 class="conn-title">
            ${escapeHtml(c.label)}
            <span class="tier ${escapeHtml(c.tier)}">${tierLabel(c.tier)}</span>
          </h3>
        </div>
        <div class="conn-body">
          <dl class="conn-meta-grid">
            <div class="meta-row"><dt>商家</dt><dd>${escapeHtml(c.providerId)}</dd></div>
            <div class="meta-row"><dt>优先级</dt><dd>${escapeHtml(String(c.priority))}</dd></div>
            <div class="meta-row"><dt>能力</dt><dd>${escapeHtml(caps)}</dd></div>
            <div class="meta-row"><dt>地址</dt><dd>${escapeHtml(c.baseUrl || "—")}</dd></div>
            <div class="meta-row"><dt>模型</dt><dd>${escapeHtml(modelsPreview + moreModels)}</dd></div>
            <div class="meta-row"><dt>密钥</dt><dd>${c.hasApiKey ? "已保存" : "缺失"}</dd></div>
          </dl>
          <div class="conn-tags">
            <span class="pill ${on ? "ok" : "muted"}">${on ? "轮换中" : "已停用"}</span>
            ${cooling ? '<span class="pill warn">连接冷却中</span>' : ""}
            ${coolModels ? `<span class="pill warn">${escapeHtml(coolModels)}</span>` : ""}
          </div>
        </div>
        <div class="conn-foot">
          <label class="toggle" title="是否参与自动轮换">
            <input type="checkbox" data-en="${escapeHtml(c.id)}" ${on ? "checked" : ""} />
            <span class="toggle-track" aria-hidden="true"></span>
            <span class="toggle-label">${on ? "参与轮换" : "不参与"}</span>
          </label>
          <div class="conn-actions">
            <button type="button" class="btn ghost sm" data-edit="${escapeHtml(c.id)}">编辑</button>
            <button type="button" class="btn danger sm" data-del="${escapeHtml(c.id)}">删除</button>
          </div>
        </div>
      </article>`;
    })
    .join("");

  root.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => openEditConnection(btn.getAttribute("data-edit")));
  });
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
      const label = input.closest(".toggle")?.querySelector(".toggle-label");
      if (label) label.textContent = input.checked ? "参与轮换" : "不参与";
      const card = input.closest(".conn-card");
      if (card) card.classList.toggle("is-off", !input.checked);
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
      toast(input.checked ? "已加入轮换" : "已退出轮换");
    });
  });
}

function fillStrategy() {
  $("strategyMode").value = config.strategy?.mode || "priority";
  $("preferFree").checked = config.strategy?.preferFree !== false;
  if ($("preferReliable")) {
    $("preferReliable").checked = config.strategy?.preferReliable !== false;
  }
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
  const preferred = config.defaultModel || config.effectiveDefaultModel || "cizhenyu/auto";
  const sel = $("defaultModel");
  sel.innerHTML = "";
  if (!models.length) {
    const o = document.createElement("option");
    o.value = "cizhenyu/auto";
    o.textContent = "cizhenyu/auto（连接商家后生效）";
    sel.appendChild(o);
  } else {
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent =
        m === "cizhenyu/auto"
          ? `${m}（自动区分文本/看图）`
          : m.startsWith("cizhenyu/auto")
            ? `${m}（自动轮换）`
            : m;
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
  $("connEditId").value = "";
  $("connProviderId").value = p.id;
  $("connectTitle").textContent = `连接 ${p.name}`;
  $("connectHint").textContent = p.signupUrl
    ? "若尚未注册，请先点卡片上的「去注册」，拿到 Key 后再粘贴到这里。"
    : "填写自定义 OpenAI 兼容地址与密钥。";
  $("connLabel").value = p.name;
  $("connBaseUrl").value = p.baseUrl || "";
  $("baseUrlField").style.display = "block";
  $("connApiKey").value = "";
  $("connApiKey").required = true;
  $("connApiKey").placeholder = "";
  $("connModels").value = (p.models || []).join(", ");
  const tiers = providerTiers(p);
  $("connPriority").value =
    Number(p.defaultPriority) > 0
      ? Number(p.defaultPriority)
      : tiers.includes("free")
        ? 10
        : tiers.includes("trial")
          ? 20
          : 30;
  $("connectDialog").showModal();
}

function selectedProtocol() {
  const el = document.querySelector('input[name="provProtocol"]:checked');
  return el?.value || "openai";
}

function selectedTiers() {
  return [...document.querySelectorAll("#provTiers input[type=checkbox]:checked")].map(
    (el) => el.value,
  );
}

function setSelectedTiers(tiers) {
  const set = new Set(tiers || []);
  document.querySelectorAll("#provTiers input[type=checkbox]").forEach((el) => {
    el.checked = set.has(el.value);
  });
}

function setSelectedProtocol(protocol) {
  const want = protocol || "openai";
  document.querySelectorAll('input[name="provProtocol"]').forEach((el) => {
    el.checked = el.value === want;
  });
}

function openProviderDialog(editId) {
  const p = editId ? (catalog.providers || []).find((x) => x.id === editId && x.custom) : null;
  $("providerTitle").textContent = p ? `编辑 ${p.name}` : "添加供应商";
  $("provEditId").value = p?.id || "";
  $("provName").value = p?.name || "";
  $("provNotes").value = p?.notes || "";
  $("provModels").value = (p?.models || []).join(", ");
  $("provBaseUrl").value = p?.baseUrl || "";
  $("provApiKey").value = "";
  $("provApiKey").placeholder = p
    ? "留空则只更新商家卡片，不新建连接"
    : "可选；填写则同时建立连接";
  $("provPriority").value = Number(p?.defaultPriority) > 0 ? Number(p.defaultPriority) : 30;
  $("provGuide").value = p?.quotaHint || "";
  $("provSignupUrl").value = p?.signupUrl || "";
  $("provDocsUrl").value = p?.docsUrl || "";
  setSelectedProtocol(p?.protocol || "openai");
  setSelectedTiers(p ? providerTiers(p) : ["custom"]);
  $("providerDialog").showModal();
  $("provName").focus();
}

let confirmResolver = null;

function askConfirm({ title = "确认操作", message = "", confirmText = "确认", danger = false } = {}) {
  return new Promise((resolve) => {
    if (confirmResolver) {
      confirmResolver(false);
      confirmResolver = null;
    }
    confirmResolver = resolve;
    $("confirmTitle").textContent = title;
    $("confirmMessage").textContent = message;
    const ok = $("btnConfirmOk");
    ok.textContent = confirmText;
    ok.className = danger ? "btn danger" : "btn primary";
    $("confirmDialog").showModal();
  });
}

function settleConfirm(ok) {
  const resolve = confirmResolver;
  confirmResolver = null;
  closeDialog("confirmDialog");
  if (resolve) resolve(Boolean(ok));
}

async function deleteCustomProvider(id) {
  if (!id) return;
  const p = (catalog.providers || []).find((x) => x.id === id);
  const name = p?.name || "该自定义商家";
  const ok = await askConfirm({
    title: "删除供应商",
    message: `确定删除「${name}」？此操作不可恢复。已有连接不会自动删除，可在「我的连接」中另行处理。`,
    confirmText: "确认删除",
    danger: true,
  });
  if (!ok) return;
  const res = await fetch(`/api/catalog/custom/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || "删除失败");
    return;
  }
  if (data.catalog) catalog = data.catalog;
  renderCatalog();
  toast("已删除自定义商家");
}

/** 编辑已有连接：可改名称 / Base URL / 模型 / 密钥（密钥留空则保留） */
function openEditConnection(connId) {
  const c = (config?.connections || []).find((x) => x.id === connId);
  if (!c) {
    toast("找不到该连接");
    return;
  }
  const p = (catalog.providers || []).find((x) => x.id === c.providerId);
  $("connEditId").value = c.id;
  $("connProviderId").value = c.providerId || "custom";
  $("connectTitle").textContent = `编辑 ${c.label || c.providerId}`;
  $("connectHint").textContent = p?.signupUrl
    ? "可更新密钥与模型列表。API Key 留空表示保持原密钥不变。"
    : "编辑连接参数。API Key 留空表示保持原密钥不变。";
  $("connLabel").value = c.label || "";
  $("connBaseUrl").value = c.baseUrl || p?.baseUrl || "";
  $("baseUrlField").style.display = "block";
  $("connApiKey").value = "";
  $("connApiKey").required = false;
  $("connApiKey").placeholder = c.hasApiKey ? "已保存（留空不修改）" : "请填写 API Key";
  $("connModels").value = (c.models || p?.models || []).join(", ");
  $("connPriority").value = Number(c.priority) || 10;
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
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    $(`panel-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "strategy") void refreshRoute();
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

function closeDialog(id) {
  const el = $(id);
  if (el?.open) el.close();
}

document.querySelectorAll("[data-close-dialog]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.getAttribute("data-close-dialog");
    if (id === "confirmDialog") settleConfirm(false);
    else closeDialog(id);
  });
});

$("btnConnectCancel").addEventListener("click", () => closeDialog("connectDialog"));
$("btnAddProvider")?.addEventListener("click", () => openProviderDialog());
$("btnProviderCancel")?.addEventListener("click", () => closeDialog("providerDialog"));
$("btnConfirmCancel")?.addEventListener("click", () => settleConfirm(false));
$("confirmForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  settleConfirm(true);
});
$("confirmDialog")?.addEventListener("cancel", (e) => {
  e.preventDefault();
  settleConfirm(false);
});

$("providerForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tiers = selectedTiers();
  if (!tiers.length) {
    toast("请至少选择一个分类");
    return;
  }
  const models = $("provModels").value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const payload = {
    id: ($("provEditId").value || "").trim() || undefined,
    name: $("provName").value.trim(),
    notes: $("provNotes").value.trim(),
    guide: $("provGuide").value.trim(),
    models,
    baseUrl: $("provBaseUrl").value.trim(),
    apiKey: $("provApiKey").value.trim(),
    priority: Number($("provPriority").value) || 30,
    signupUrl: $("provSignupUrl").value.trim(),
    docsUrl: $("provDocsUrl").value.trim(),
    protocol: selectedProtocol(),
    tiers,
    connect: Boolean($("provApiKey").value.trim()),
  };
  const res = await fetch("/api/catalog/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || "保存失败");
    return;
  }
  if (data.catalog) catalog = data.catalog;
  $("providerDialog").close();
  if (data.connections || data.localApiKey || data.strategy) {
    applyConfigPayload(data);
  } else {
    renderCatalog();
  }
  toast(
    payload.apiKey
      ? "已添加商家并创建连接。请重新打开 Agent 使接线生效。"
      : payload.id
        ? "已更新自定义商家"
        : "已添加自定义商家；可再点「填入密钥」建连接",
  );
  if (payload.apiKey) document.querySelector('.tab[data-tab="connections"]')?.click();
});

$("connectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const providerId = $("connProviderId").value;
  const editId = ($("connEditId").value || "").trim();
  const models = $("connModels").value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const apiKey = $("connApiKey").value.trim();
  if (!editId && !apiKey) {
    toast("请填写 API Key");
    return;
  }
  const payload = {
    providerId,
    label: $("connLabel").value.trim(),
    baseUrl: $("connBaseUrl").value.trim(),
    models,
    priority: Number($("connPriority").value) || 10,
    enabled: true,
  };
  if (editId) payload.id = editId;
  // 编辑且留空：不传 apiKey，服务端保留原值
  if (apiKey) payload.apiKey = apiKey;
  else if (!editId) payload.apiKey = "";
  const res = await fetch("/api/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || "保存失败");
    return;
  }
  $("connectDialog").close();
  applyConfigPayload(data);
  toast(editId ? "已更新连接。请重新打开 Agent 使接线生效。" : "已连接。请到「我的连接 / 策略」确认，并重新打开 Agent。");
  document.querySelector('.tab[data-tab="connections"]').click();
});

$("btnSaveStrategy").addEventListener("click", async () => {
  const res = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      defaultModel: $("defaultModel").value || "cizhenyu/auto",
      strategy: {
        modelCooldownSeconds: Number($("modelCooldownSeconds")?.value) || 300,
        injectPhysicalModels: Boolean($("injectPhysicalModels")?.checked),
        maxAttemptsPerRequest: 5,
        remapOnModelError: true,
        mode: $("strategyMode").value,
        preferFree: $("preferFree").checked,
        preferReliable: Boolean($("preferReliable")?.checked),
        cooldownSeconds: Number($("cooldownSeconds").value) || 120,
      },
      connections: (config.connections || []).map((c) => ({ ...c, apiKey: "" })),
    }),
  });
  applyConfigPayload(await res.json());
  toast("策略已保存并尝试重新接线");
});

$("btnResetRouteStats")?.addEventListener("click", async () => {
  await fetch("/api/route-stats/reset", { method: "POST" });
  await refreshRoute();
  toast("已清空成功率统计");
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
