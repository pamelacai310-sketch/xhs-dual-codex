"use strict";

const elements = {
  runBadge: document.getElementById("runBadge"),
  pageStatus: document.getElementById("pageStatus"),
  startButton: document.getElementById("startButton"),
  stopButton: document.getElementById("stopButton"),
  noteCount: document.getElementById("noteCount"),
  membershipCount: document.getElementById("membershipCount"),
  missingDetailCount: document.getElementById("missingDetailCount"),
  safeExportButton: document.getElementById("safeExportButton"),
  privateExportButton: document.getElementById("privateExportButton"),
  scopeSelect: document.getElementById("scopeSelect"),
  enrichButton: document.getElementById("enrichButton"),
  pauseEnrichButton: document.getElementById("pauseEnrichButton"),
  enrichStatus: document.getElementById("enrichStatus"),
  diagnostics: document.getElementById("diagnostics"),
  purgeTokensButton: document.getElementById("purgeTokensButton"),
  deleteScopeButton: document.getElementById("deleteScopeButton"),
  notice: document.getElementById("notice")
};

let activeTabId = null;
let latestSummary = null;
let currentPageStatus = null;
let latestEnrichment = null;
let refreshInFlight = null;
let refreshRequested = false;
let exportBusy = false;

function backgroundMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function tabMessage(message) {
  return new Promise((resolve, reject) => {
    if (activeTabId === null) {
      reject(new Error("当前没有可用的小红书页面"));
      return;
    }
    chrome.tabs.sendMessage(activeTabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error("请先打开小红书网页版并刷新页面"));
      else resolve(response);
    });
  });
}

function showNotice(text, isError) {
  elements.notice.textContent = text || "";
  elements.notice.classList.toggle("error", Boolean(isError));
}

function modeLabel(mode) {
  if (mode === "liked") return "赞过";
  if (mode === "collected") return "收藏";
  return "未识别";
}

function setBadge(text, style) {
  elements.runBadge.textContent = text;
  elements.runBadge.className = `badge ${style}`;
}

function renderPageStatus(status) {
  currentPageStatus = status;
  if (!status) {
    elements.pageStatus.textContent = "请打开 www.xiaohongshu.com，并进入自己的“收藏”或“赞过”。";
    elements.startButton.disabled = true;
    elements.stopButton.disabled = true;
    setBadge("未连接", "neutral");
    return;
  }
  if (status.running) {
    const label = status.account && status.account.label ? status.account.label : "当前账号";
    elements.pageStatus.textContent = `${label} · ${modeLabel(status.mode)} · 已见 ${status.dom_unique || 0} 条页面记录，接口页 ${status.api_pages || 0}`;
    elements.startButton.disabled = true;
    elements.stopButton.disabled = false;
    setBadge("采集中", "running");
  } else {
    const verifiedAccount = status.account && status.account.verified ? status.account : null;
    elements.pageStatus.textContent = status.mode === "unknown"
      ? "已连接，但尚未确认“收藏”或“赞过”栏目。"
      : verifiedAccount
        ? `${verifiedAccount.label || "当前账号"} · 已核验 · ${modeLabel(status.mode)}`
        : `已识别当前栏目：${modeLabel(status.mode)}；尚未核验为当前登录账号。`;
    elements.startButton.disabled = status.mode === "unknown";
    elements.stopButton.disabled = true;
    if (!latestSummary || !latestSummary.recent_runs || !latestSummary.recent_runs.length) setBadge("未采集", "neutral");
  }
}

function renderScopes(scopes) {
  const previous = elements.scopeSelect.value;
  const first = document.createElement("option");
  first.value = "";
  first.textContent = "请选择一个账号栏目";
  elements.scopeSelect.replaceChildren(first);
  for (const scope of scopes || []) {
    const option = document.createElement("option");
    option.value = scope.scope_key;
    const verified = scope.account_verified ? "" : "（账号未核验）";
    option.textContent = `${scope.account_label} · ${modeLabel(scope.mode)} · ${scope.item_count} 条${verified}`;
    elements.scopeSelect.append(option);
  }
  if (Array.from(elements.scopeSelect.options).some((option) => option.value === previous)) {
    elements.scopeSelect.value = previous;
  } else {
    const accountKey = currentPageStatus && currentPageStatus.account && currentPageStatus.account.verified
      ? currentPageStatus.account.account_key
      : "";
    const preferred = (scopes || []).find((scope) => scope.account_key === accountKey && scope.mode === currentPageStatus?.mode);
    if (preferred) elements.scopeSelect.value = preferred.scope_key;
  }
  elements.deleteScopeButton.disabled = !elements.scopeSelect.value;
  elements.purgeTokensButton.disabled = !elements.scopeSelect.value;
}

function renderDiagnostics(runs) {
  const run = runs && runs[0];
  if (!run) {
    elements.diagnostics.textContent = "尚无采集记录。";
    return;
  }
  const source = run.source_counts || {};
  const status = run.complete ? "完整" : (run.status === "running" ? "进行中" : "部分");
  const lines = [
    `${run.account && run.account.label ? run.account.label : "未知账号"} · ${modeLabel(run.mode)} · ${status}`,
    `唯一记录：${run.unique_items ?? "—"}；接口页：${run.api_pages || 0}`,
    `来源：XHR ${source.xhr || 0} / Fetch ${source.fetch || 0} / SSR ${source.ssr || 0} / DOM ${source.dom || 0}`,
    `缺失：标题 ${run.missing_title_count ?? "—"} / 作者 ${run.missing_author_count ?? "—"} / 正文 ${run.missing_detail_count ?? "—"} / 令牌 ${run.missing_token_count ?? "—"}`,
    `最后 has_more：${run.last_has_more === null ? "未知" : String(run.last_has_more)}`,
    `停止原因：${run.stop_reason || "—"}`
  ];
  if (run.last_error) lines.push(`错误：${run.last_error}`);
  elements.diagnostics.textContent = lines.join("\n");
  if (!currentPageStatus || !currentPageStatus.running) setBadge(status, run.complete ? "complete" : "partial");
}

function renderEnrichment(job) {
  const value = job || { status: "idle", remaining: 0, completed: 0, failed: 0, skipped: 0 };
  latestEnrichment = value;
  const remaining = Number.isInteger(value.remaining) ? value.remaining : 0;
  const labels = {
    idle: "尚未开始",
    running: "正在低速补全",
    paused: "已暂停",
    complete: "已完成"
  };
  const phase = value.current_note_id
    ? ` 当前处理 ${value.current_note_id}（${value.phase || "准备中"}${value.attempt ? `，第 ${value.attempt} 次` : ""}）。`
    : "";
  elements.enrichStatus.textContent = `${labels[value.status] || value.status}；已完成 ${value.completed || 0}，失败 ${value.failed || 0}，跳过 ${value.skipped || 0}，剩余 ${remaining}。${phase}${value.last_error ? ` ${value.last_error}` : ""}`;
  const currentAccountKey = currentPageStatus && currentPageStatus.account && currentPageStatus.account.verified
    ? currentPageStatus.account.account_key
    : "";
  const selectedScope = latestSummary && Array.isArray(latestSummary.scopes)
    ? latestSummary.scopes.find((scope) => scope.scope_key === elements.scopeSelect.value)
    : null;
  const selectedIsCurrentVerifiedAccount = Boolean(selectedScope
    && selectedScope.account_verified
    && selectedScope.account_key === currentAccountKey);
  elements.enrichButton.disabled = value.status === "running" || !selectedIsCurrentVerifiedAccount;
  elements.enrichButton.textContent = value.status === "paused"
    && value.scope_key === elements.scopeSelect.value
    && value.account_key === currentAccountKey
    ? "继续低速补全"
    : "开始低速补全";
  elements.pauseEnrichButton.disabled = value.status !== "running";
}

async function refreshOnce() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    activeTabId = tab && /^https:\/\/www\.xiaohongshu\.com\//.test(tab.url || "") ? tab.id : null;
    if (activeTabId !== null) {
      try {
        const page = await tabMessage({ type: "GET_CONTENT_STATUS" });
        renderPageStatus(page && page.status ? page.status : null);
      } catch (_) {
        renderPageStatus(null);
      }
    } else {
      renderPageStatus(null);
    }
    const summary = await backgroundMessage({ type: "GET_SUMMARY" });
    if (!summary || !summary.ok) throw new Error(summary && summary.error ? summary.error : "读取总库失败");
    latestSummary = summary;
    elements.noteCount.textContent = String(summary.note_count || 0);
    elements.membershipCount.textContent = String(summary.membership_count || 0);
    elements.missingDetailCount.textContent = String(summary.missing_description_count || 0);
    renderScopes(summary.scopes);
    renderDiagnostics(summary.active_runs && summary.active_runs.length ? summary.active_runs : summary.recent_runs);
    renderEnrichment(summary.enrichment);
  } catch (error) {
    showNotice(error.message, true);
  }
}

function refresh() {
  refreshRequested = true;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    while (refreshRequested) {
      refreshRequested = false;
      await refreshOnce();
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function exportFilename(privateMode) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return privateMode
    ? `xhs-private-archive-CONTAINS-TOKENS-${stamp}.json`
    : `xhs-codex-sanitized-${stamp}.json`;
}

async function downloadExport(privateMode) {
  const response = await backgroundMessage({ type: "BUILD_EXPORT", privateMode });
  if (!response || !response.ok) throw new Error(response && response.error ? response.error : "导出失败");
  const blob = new Blob([JSON.stringify(response.payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exportFilename(privateMode);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function runExport(privateMode) {
  if (exportBusy) return;
  exportBusy = true;
  elements.safeExportButton.disabled = true;
  elements.privateExportButton.disabled = true;
  try {
    await downloadExport(privateMode);
  } finally {
    exportBusy = false;
    elements.safeExportButton.disabled = false;
    elements.privateExportButton.disabled = false;
  }
}

elements.startButton.addEventListener("click", async () => {
  showNotice("正在启动……", false);
  try {
    const response = await tabMessage({ type: "START_CAPTURE" });
    if (!response || !response.ok) throw new Error(response && response.error ? response.error : "启动失败");
    showNotice("已开始。可关闭此小窗口，网页会继续缓慢滚动。", false);
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  }
});

elements.stopButton.addEventListener("click", async () => {
  try {
    const response = await tabMessage({ type: "STOP_CAPTURE" });
    if (!response || !response.ok) throw new Error(response && response.error ? response.error : "停止记录保存失败");
    showNotice("已停止；未确认到底的数据会标记为“部分”。", false);
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  }
});

elements.safeExportButton.addEventListener("click", async () => {
  try {
    await runExport(false);
    showNotice("去敏总库已下载，可交给 builder 生成 Codex 项目。", false);
  } catch (error) {
    showNotice(error.message, true);
  }
});

elements.privateExportButton.addEventListener("click", async () => {
  const confirmed = window.confirm("私密原始归档包含 xsec_token。只应保存在本人电脑，不能上传给 Codex、网盘、群聊或公开仓库。仍要导出吗？");
  if (!confirmed) return;
  try {
    await runExport(true);
    showNotice("私密原始归档已下载，请妥善保管。", false);
  } catch (error) {
    showNotice(error.message, true);
  }
});

elements.enrichButton.addEventListener("click", async () => {
  const option = elements.scopeSelect.selectedOptions[0];
  const account = currentPageStatus && currentPageStatus.account;
  if (!option || !option.value || !account || !account.verified) {
    showNotice("请先停留在当前登录账号自己的主页，并选择该账号的一个已核验栏目。", true);
    return;
  }
  const confirmed = window.confirm(`将只补全当前已核验账号的“${option.textContent}”。补全会低速打开笔记详情页；出现登录跳转、身份不一致或安全验证会立即暂停。继续吗？`);
  if (!confirmed) return;
  try {
    const response = await backgroundMessage({
      type: "START_ENRICHMENT",
      scopeKey: option.value,
      currentAccountKey: account.account_key
    });
    if (!response || !response.ok) throw new Error(response && response.error ? response.error : "无法开始补全");
    showNotice("已启动低速补全；关闭此小窗口不影响任务。", false);
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  }
});

elements.pauseEnrichButton.addEventListener("click", async () => {
  try {
    const response = await backgroundMessage({ type: "PAUSE_ENRICHMENT" });
    if (!response || !response.ok) throw new Error(response && response.error ? response.error : "暂停失败");
    showNotice("补全已暂停。", false);
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  }
});

elements.scopeSelect.addEventListener("change", () => {
  elements.deleteScopeButton.disabled = !elements.scopeSelect.value;
  elements.purgeTokensButton.disabled = !elements.scopeSelect.value;
  renderEnrichment(latestEnrichment);
});

elements.purgeTokensButton.addEventListener("click", async () => {
  const option = elements.scopeSelect.selectedOptions[0];
  if (!option || !option.value) return;
  const scopeLabel = `“${option.textContent}”`;
  const confirmed = window.confirm(`确认清除${scopeLabel}保存的 xsec_token 吗？清除后不能用这些令牌补全正文，建议先完成补全或导出私密原始归档。`);
  if (!confirmed) return;
  try {
    const response = await backgroundMessage({ type: "PURGE_TOKENS", scopeKey: elements.scopeSelect.value });
    if (!response || !response.ok) throw new Error(response && response.error ? response.error : "清除失败");
    showNotice(`已清除 ${response.purged} 条访问令牌。`, false);
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  }
});

elements.deleteScopeButton.addEventListener("click", async () => {
  const option = elements.scopeSelect.selectedOptions[0];
  if (!option || !option.value) return;
  const confirmed = window.confirm(`确认删除“${option.textContent}”吗？此操作无法从扩展内撤销，建议先导出备份。`);
  if (!confirmed) return;
  try {
    const response = await backgroundMessage({ type: "DELETE_SCOPE", scopeKey: option.value });
    if (!response || !response.ok) throw new Error(response && response.error ? response.error : "删除失败");
    showNotice(`已删除 ${response.deleted_memberships} 条栏目记录。`, false);
    await refresh();
  } catch (error) {
    showNotice(error.message, true);
  }
});

refresh();
window.setInterval(() => { refresh(); }, 2500);
