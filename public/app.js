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
  const list = (catalog.providers || []).filter((p) => tierFilter === "all" || p.tier === tierFilter);
  if (!list.length) {
    root.innerHTML = '<div class="empty"><strong>暂无商家</strong>换一个档位再看看</div>';
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
        <span class="tier ${escapeHtml(p.tier)}">${tierLabel(p.tier)}</span>
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
          <button type="button" class="btn danger sm" data-del="${escapeHtml(c.id)}">删除</button>
        </div>
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
  $("connProviderId").value = p.id;
  $("connectTitle").textContent = `连接 ${p.name}`;
  $("connectHint").textContent = p.signupUrl
    ? "若尚未注册，请先点卡片上的「去注册」，拿到 Key 后再粘贴到这里。"
    : "填写自定义 OpenAI 兼容地址与密钥。";
  $("connLabel").value = p.name;
  $("connBaseUrl").value = p.baseUrl || "";
  $("baseUrlField").style.display = "block";
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
