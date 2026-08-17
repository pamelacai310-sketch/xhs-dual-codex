(function startXhsDualContentRelay() {
  "use strict";

  const CHANNEL = "xhs-dual-codex-v1";
  const MAX_ITEMS_PER_MESSAGE = 250;
  const MAX_PENDING_MESSAGES = 20;
  const MAX_CAPTURE_IDS = 6000;
  const lib = globalThis.XHSDualLib;
  if (!lib) return;

  let activeRun = null;
  let lastResolvedAccount = null;
  let accountProbePromise = null;
  let lastAccountProbeAt = 0;
  let bridgeProcessingQueue = Promise.resolve();
  let stopCapturePromise = null;
  const seenCaptureIds = new Set();
  const captureIdQueue = [];
  let scrollTimer = null;
  let pendingBridgeMessages = [];
  let lastVisibleCount = 0;
  let stagnantTicks = 0;
  let lastHasMore = null;
  let totalApiPages = 0;
  let latestCursor = "";
  let seenDomIds = new Set();

  function isoNow() {
    return new Date().toISOString();
  }

  function activeTabText() {
    const selectors = [
      "[role='tab'][aria-selected='true']",
      ".reds-tab-item.active",
      ".tab-item.active",
      ".active-tab",
      ".tab.active"
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = element && element.textContent ? element.textContent.trim() : "";
      if (text) return text.slice(0, 100);
    }
    return "";
  }

  function profileIdFromLocation() {
    const match = location.pathname.match(/\/user\/profile\/([0-9a-zA-Z_-]{8,80})/i);
    return match ? match[1] : "";
  }

  function accountLabel() {
    const selectors = [
      ".user-name",
      ".username",
      ".user-info .name",
      "[class*='user-name']",
      "[class*='username']"
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = element && element.textContent ? element.textContent.replace(/\s+/g, " ").trim() : "";
      if (value) return value.slice(0, 200);
    }
    return document.title.replace(/\s*[-—|].*$/, "").trim().slice(0, 200) || "未命名账号";
  }

  function currentIdentity(selfId) {
    const profileId = profileIdFromLocation();
    if (!profileId) return null;
    if (selfId && selfId !== profileId) return null;
    if (selfId === profileId) {
      return {
        account_key: `xhs:${profileId}`,
        user_id: profileId,
        profile_id: profileId,
        label: accountLabel(),
        verified: true
      };
    }
    return {
      account_key: `unverified:${crypto.randomUUID()}`,
      user_id: "",
      profile_id: profileId,
      label: accountLabel(),
      verified: false
    };
  }

  function resolvedSelfId(messages) {
    for (const message of (messages || []).slice().reverse()) {
      if (!message || typeof message.endpoint !== "string") continue;
      if (message.endpoint !== "initial-state" && !/\/api\/sns\/web\/v\d+\/user\/(?:me|selfinfo)(?:\?|$)/i.test(message.endpoint)) continue;
      const value = lib.extractSelfId(message.payload);
      if (value) return value;
    }
    return "";
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function bridgeControl(action, runId) {
    window.postMessage({
      channel: CHANNEL,
      kind: "CONTROL",
      action,
      runId
    }, location.origin);
  }

  function captureStatus() {
    const currentProfileId = profileIdFromLocation();
    const rememberedAccount = lastResolvedAccount && lastResolvedAccount.profile_id === currentProfileId
      ? lastResolvedAccount
      : null;
    return {
      running: Boolean(activeRun),
      run_id: activeRun ? activeRun.run_id : "",
      account: activeRun ? activeRun.account : rememberedAccount,
      mode: activeRun ? activeRun.mode : lib.detectMode(location.href, activeTabText()),
      started_at: activeRun ? activeRun.started_at : "",
      last_has_more: lastHasMore,
      latest_cursor: latestCursor,
      api_pages: totalApiPages,
      dom_unique: seenDomIds.size,
      stagnant_ticks: stagnantTicks
    };
  }

  async function updateRunStatus(extra) {
    if (!activeRun) return;
    try {
      await runtimeMessage({
        type: "UPDATE_RUN",
        runId: activeRun.run_id,
        status: Object.assign(captureStatus(), extra || {})
      });
    } catch (_) {
      // The page should remain usable if the extension reloads mid-run.
    }
  }

  function endpointPath(endpoint) {
    try {
      return new URL(endpoint, location.origin).pathname;
    } catch (_) {
      return "";
    }
  }

  function isExpectedListingEndpoint(endpoint, mode) {
    const path = endpointPath(endpoint);
    if (mode === "liked") return /\/api\/sns\/web\/v\d+\/note\/(?:like|likes)\/page$/i.test(path);
    if (mode === "collected") return /\/api\/sns\/web\/v\d+\/note\/(?:collect|collection|favorite|favorites)\/page$/i.test(path);
    return false;
  }

  function requestCursorFromEndpoint(endpoint) {
    try {
      return (new URL(endpoint, location.origin).searchParams.get("cursor") || "").slice(0, 2048);
    } catch (_) {
      return "";
    }
  }

  async function recordListPage(data, pageInfo, itemCount) {
    if (!activeRun) return;
    const response = await runtimeMessage({
      type: "RECORD_LIST_PAGE",
      runId: activeRun.run_id,
      account: activeRun.account,
      mode: activeRun.mode,
      endpoint: endpointPath(data.endpoint),
      transport: data.transport,
      httpStatus: data.httpStatus,
      requestCursor: requestCursorFromEndpoint(data.endpoint),
      nextCursor: pageInfo.cursor || "",
      hasMore: pageInfo.has_more,
      itemCount,
      capturedAt: data.capturedAt || isoNow()
    });
    if (!response || !response.ok) throw new Error(response && response.error ? response.error : "分页记录失败");
  }

  async function rejectListResponse(stopReason, error) {
    if (!activeRun || activeRun.pending_stop_reason) return;
    activeRun.pending_stop_reason = stopReason;
    try {
      await updateRunStatus({
        last_error: error,
        last_http_error_at: isoNow()
      });
    } finally {
      window.setTimeout(() => {
        if (!activeRun || activeRun.pending_stop_reason !== stopReason) return;
        stopCapture(stopReason, false).catch(() => {});
      }, 0);
    }
  }

  async function sendItems(items, metadata) {
    if (!activeRun || !Array.isArray(items)) return;
    const chunks = items.length
      ? Array.from({ length: Math.ceil(items.length / MAX_ITEMS_PER_MESSAGE) }, (_, index) =>
          items.slice(index * MAX_ITEMS_PER_MESSAGE, (index + 1) * MAX_ITEMS_PER_MESSAGE))
      : [[]];
    for (const chunk of chunks) {
      const response = await runtimeMessage({
        type: "UPSERT_ITEMS",
        runId: activeRun.run_id,
        account: activeRun.account,
        mode: activeRun.mode,
        items: chunk,
        endpoint: metadata.endpoint || "",
        transport: metadata.transport || "unknown",
        capturedAt: metadata.capturedAt || isoNow()
      });
      if (!response || !response.ok) throw new Error(response && response.error ? response.error : "保存失败");
    }
  }

  async function processBridgeMessage(data) {
    if (!activeRun || data.runId !== activeRun.run_id) return;
    if (!lib.endpointAllowed(data.endpoint) || !isExpectedListingEndpoint(data.endpoint, activeRun.mode)) return;
    if (data.transport !== "fetch" && data.transport !== "xhr") return;
    if (activeRun.pending_stop_reason) return;
    activeRun.bridge_events += 1;
    if (activeRun.bridge_events > 5000) {
      activeRun.pending_stop_reason = "bridge_event_limit";
      await updateRunStatus({ last_error: "接口事件数量超过安全上限，采集将停止并标记为部分。" });
      return;
    }

    const responseCode = data.payload && typeof data.payload === "object" ? data.payload.code : undefined;
    if (data.httpStatus === 429 || [461, 471, -13002, "461", "471", "-13002"].includes(responseCode)) {
      await rejectListResponse("risk_control", "列表接口触发访问频繁或安全验证；本次采集已标记为部分。");
      return;
    }
    if (data.httpStatus === 401 || data.httpStatus === 403) {
      await rejectListResponse("auth_failed", "列表接口登录状态失效或无权访问；请重新登录并核验当前账号。");
      return;
    }
    if (data.httpStatus >= 500 && data.httpStatus <= 599) {
      await rejectListResponse("server_error", `列表接口返回 HTTP ${data.httpStatus}；错误响应未计入分页，本次采集已标记为部分。`);
      return;
    }
    if (!Number.isInteger(data.httpStatus) || data.httpStatus < 200 || data.httpStatus >= 300) {
      await rejectListResponse("http_error", `列表接口返回无效 HTTP 状态 ${data.httpStatus || "未知"}；错误响应未计入分页。`);
      return;
    }

    const context = {
      mode: activeRun.mode,
      source: ["fetch", "xhr", "ssr"].includes(data.transport) ? data.transport : "api",
      capturedAt: data.capturedAt || isoNow(),
      maxDepth: 4,
      maxNodes: 10000
    };
    const items = lib.extractListItems(data.payload, context).slice(0, 5000);
    const pageInfo = lib.extractPageInfo(data.payload);
    totalApiPages += 1;
    if (pageInfo.has_more !== null) lastHasMore = pageInfo.has_more;
    if (pageInfo.cursor) latestCursor = pageInfo.cursor;
    await recordListPage(data, pageInfo, items.length);
    if (items.length) {
      await sendItems(items, {
        endpoint: endpointPath(data.endpoint),
        transport: data.transport,
        capturedAt: data.capturedAt
      });
      stagnantTicks = 0;
    }
    await updateRunStatus({
      last_event_at: isoNow(),
      last_transport: data.transport,
      last_endpoint: endpointPath(data.endpoint),
      last_batch_items: items.length
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.kind !== "CAPTURE_DATA") return;
    if (typeof data.endpoint !== "string" || data.endpoint.length > 2000 || !lib.endpointAllowed(data.endpoint)) return;
    if (typeof data.runId !== "string" || data.runId.length > 80 || !/^[a-f0-9-]{20,80}$/i.test(data.runId)) return;
    if (typeof data.captureId !== "string" || data.captureId.length !== 36) return;
    if (typeof data.transport !== "string" || data.transport.length > 20) return;
    if (data.capturedAt !== undefined && (typeof data.capturedAt !== "string" || data.capturedAt.length > 100)) return;
    const payload = lib.boundedBridgePayload(data.payload);
    if (payload === null) return;
    if (activeRun && data.runId !== activeRun.run_id) return;
    if (!lib.acceptCaptureId(data.captureId, seenCaptureIds, captureIdQueue, MAX_CAPTURE_IDS)) return;
    const bounded = {
      captureId: data.captureId,
      runId: typeof data.runId === "string" ? data.runId.slice(0, 80) : "",
      endpoint: data.endpoint.slice(0, 2000),
      transport: typeof data.transport === "string" ? data.transport.slice(0, 20) : "unknown",
      httpStatus: Number.isInteger(data.httpStatus) ? data.httpStatus : 0,
      payload,
      capturedAt: typeof data.capturedAt === "string" ? data.capturedAt.slice(0, 100) : isoNow()
    };
    if (!activeRun) {
      pendingBridgeMessages.push(bounded);
      if (pendingBridgeMessages.length > MAX_PENDING_MESSAGES) pendingBridgeMessages.shift();
      return;
    }
    if (activeRun.stopping) return;
    const operation = bridgeProcessingQueue.then(() => processBridgeMessage(bounded));
    bridgeProcessingQueue = operation.catch(async (error) => {
      await updateRunStatus({ last_error: String(error && error.message ? error.message : error).slice(0, 500) });
    });
  });

  function textFrom(root, selectors, maxLength) {
    if (!root) return "";
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = element && element.textContent ? element.textContent.replace(/\s+/g, " ").trim() : "";
      if (text) return text.slice(0, maxLength || 1000);
    }
    return "";
  }

  function visibleElement(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && !element.hidden;
  }

  function activeListRoot() {
    const selectors = [
      "[role='tabpanel']:not([hidden])",
      "[class*='feeds-container']",
      "[class*='note-list']",
      "[class*='feeds-page']",
      "main"
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!visibleElement(element)) continue;
        if (element.querySelector("a[href*='/explore/'], a[href*='/discovery/item/']")) return element;
      }
    }
    return null;
  }

  function domItems() {
    const mode = activeRun ? activeRun.mode : lib.detectMode(location.href, activeTabText());
    const root = activeListRoot();
    if (!root) return [];
    const anchors = Array.from(root.querySelectorAll("a[href*='/explore/'], a[href*='/discovery/item/']"))
      .filter((anchor) => !anchor.closest("[role='dialog'], dialog, [class*='modal'], [class*='recommend']"))
      .slice(0, 5000);
    const byId = new Map();
    for (const anchor of anchors) {
      let url;
      try {
        url = new URL(anchor.href, location.href);
      } catch (_) {
        continue;
      }
      if (url.hostname !== "www.xiaohongshu.com") continue;
      const match = url.pathname.match(/\/(?:explore|discovery\/item)\/([0-9a-zA-Z_-]{12,64})/i);
      if (!match) continue;
      const noteId = match[1];
      const card = anchor.closest("section, article, [class*='note-item'], [class*='card'], li") || anchor;
      const image = card.querySelector("img");
      const raw = {
        note_id: noteId,
        display_title: textFrom(card, ["[class*='title']", ".title", "h3", "h2"], 1000)
          || (image && image.alt ? image.alt.slice(0, 1000) : ""),
        user: {
          nickname: textFrom(card, ["[class*='author']", "[class*='user-name']", ".name"], 200)
        },
        liked_count: textFrom(card, ["[class*='like']", "[class*='count']"], 100),
        cover: image ? (image.currentSrc || image.src || "") : "",
        xsec_token: url.searchParams.get("xsec_token") || "",
        url: url.href
      };
      const item = lib.normalizeItem(raw, { mode, source: "dom", capturedAt: isoNow() });
      if (item) byId.set(noteId, byId.has(noteId) ? lib.mergeItems(byId.get(noteId), item) : item);
    }
    return Array.from(byId.values());
  }

  async function scanDom() {
    if (!activeRun) return 0;
    const items = domItems();
    const newlySeen = items.filter((item) => !seenDomIds.has(item.note_id));
    for (const item of items) seenDomIds.add(item.note_id);
    if (newlySeen.length) {
      await sendItems(newlySeen, {
        pageInfo: { has_more: null, cursor: "" },
        endpoint: location.pathname,
        transport: "dom",
        capturedAt: isoNow()
      });
    }
    return newlySeen.length;
  }

  function riskControlDetected() {
    const bodyText = document.body && document.body.innerText
      ? document.body.innerText.slice(0, 20000)
      : "";
    return /(安全验证|请完成验证|访问频繁|操作频繁|账号异常|网络异常.*重试|captcha)/i.test(bodyText);
  }

  function identityChanged() {
    if (!activeRun) return false;
    const nowId = profileIdFromLocation();
    return nowId !== activeRun.account.profile_id;
  }

  function nearBottom() {
    const root = document.scrollingElement || document.documentElement;
    return root.scrollTop + window.innerHeight >= root.scrollHeight - Math.max(1000, window.innerHeight);
  }

  function scheduleScroll() {
    if (!activeRun) return;
    const delay = 1100 + Math.floor(Math.random() * 900);
    scrollTimer = window.setTimeout(async () => {
      if (!activeRun) return;
      if (activeRun.pending_stop_reason) {
        await stopCapture(activeRun.pending_stop_reason, false);
        return;
      }
      if (identityChanged()) {
        await stopCapture("account_changed", false);
        return;
      }
      const currentMode = lib.detectMode(location.href, activeTabText());
      if (currentMode !== activeRun.mode) {
        await stopCapture("mode_changed", false);
        return;
      }
      if (riskControlDetected()) {
        await stopCapture("risk_control", false);
        return;
      }
      const newCount = await scanDom().catch(() => 0);
      const visibleCount = domItems().length;
      if (newCount === 0 && visibleCount <= lastVisibleCount) stagnantTicks += 1;
      else stagnantTicks = 0;
      lastVisibleCount = Math.max(lastVisibleCount, visibleCount);

      if (lastHasMore === false && stagnantTicks >= 3) {
        await stopCapture("api_complete", true);
        return;
      }
      if (nearBottom() && stagnantTicks >= 12) {
        await stopCapture(lastHasMore === true ? "stalled_has_more" : "dom_stalled", false);
        return;
      }
      const maxRuntimeMs = 30 * 60 * 1000;
      if (Date.now() - activeRun.started_ms > maxRuntimeMs) {
        await stopCapture("time_limit", false);
        return;
      }
      window.scrollBy({
        top: Math.max(500, Math.floor(window.innerHeight * (0.72 + Math.random() * 0.16))),
        left: 0,
        behavior: "smooth"
      });
      await updateRunStatus({ last_scroll_at: isoNow() });
      scheduleScroll();
    }, delay);
  }

  async function startCapture() {
    if (activeRun) return { ok: true, status: captureStatus() };
    const mode = lib.detectMode(location.href, activeTabText());
    if (mode === "unknown") {
      return { ok: false, error: "请先打开个人主页中的“收藏”或“赞过”栏目。" };
    }
    const runId = crypto.randomUUID();
    const startedAt = isoNow();
    bridgeControl("START", runId);
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    const account = currentIdentity(resolvedSelfId(pendingBridgeMessages));
    if (!account) {
      bridgeControl("STOP", runId);
      return { ok: false, error: "当前个人主页与已登录账号不一致，或页面地址无有效账号 ID。请回到自己的主页后刷新。" };
    }
    const response = await runtimeMessage({
      type: "START_RUN",
      runId,
      account,
      mode,
      pageUrl: location.href,
      startedAt
    });
    if (!response || !response.ok) {
      bridgeControl("STOP", runId);
      return response || { ok: false, error: "无法启动采集" };
    }

    activeRun = {
      run_id: runId,
      account,
      mode,
      started_at: startedAt,
      started_ms: Date.now(),
      bridge_events: 0
    };
    lastResolvedAccount = account;
    lastVisibleCount = 0;
    stagnantTicks = 0;
    lastHasMore = null;
    latestCursor = "";
    totalApiPages = 0;
    seenDomIds = new Set();
    const pending = pendingBridgeMessages;
    pendingBridgeMessages = [];
    for (const message of pending) {
      message.runId = runId;
      await processBridgeMessage(message).catch(() => {});
    }
    await scanDom();
    scheduleScroll();
    return { ok: true, status: captureStatus() };
  }

  async function finishCapture(reason, complete) {
    if (!activeRun) return { ok: true, status: captureStatus() };
    activeRun.stopping = true;
    if (scrollTimer) window.clearTimeout(scrollTimer);
    scrollTimer = null;
    const run = activeRun;
    bridgeControl("STOP", run.run_id);
    await bridgeProcessingQueue.catch(() => {});
    await scanDom().catch(() => 0);
    let finishResponse = null;
    try {
      finishResponse = await runtimeMessage({
      type: "FINISH_RUN",
      runId: run.run_id,
      result: Object.assign(captureStatus(), {
        finished_at: isoNow(),
        stop_reason: reason || "user_stop",
        complete: Boolean(complete && lastHasMore === false && totalApiPages > 0),
        completeness: complete && lastHasMore === false && totalApiPages > 0 ? "complete" : "partial"
      })
      });
    } catch (error) {
      finishResponse = { ok: false, error: error.message };
    }
    activeRun = null;
    if (!finishResponse || !finishResponse.ok) {
      return { ok: false, error: finishResponse && finishResponse.error ? finishResponse.error : "采集停止了，但诊断记录保存失败", status: captureStatus() };
    }
    return { ok: true, status: captureStatus() };
  }

  function stopCapture(reason, complete) {
    if (stopCapturePromise) return stopCapturePromise;
    if (!activeRun) return Promise.resolve({ ok: true, status: captureStatus() });
    stopCapturePromise = finishCapture(reason, complete).finally(() => {
      stopCapturePromise = null;
    });
    return stopCapturePromise;
  }

  function metaContent(selector) {
    const element = document.querySelector(selector);
    return element && element.content ? element.content.trim() : "";
  }

  function detailFailure(error, fields) {
    return Object.assign({ ok: false, error }, fields || {});
  }

  function extractDetailFromDom(expectedNoteId, expectedSelfId) {
    const expectedId = lib.validNoteId(expectedNoteId);
    let pageUrl;
    try {
      pageUrl = new URL(location.href);
    } catch (_) {
      return detailFailure("详情页地址无效", { identityMismatch: true });
    }
    if (pageUrl.origin !== "https://www.xiaohongshu.com"
      || !expectedId
      || pageUrl.pathname !== `/explore/${expectedId}`) {
      return detailFailure("详情页已跳转、登录失效或笔记地址不匹配", { identityMismatch: true });
    }
    if (riskControlDetected()) return { ok: false, error: "risk_control", riskControl: true };
    const noteId = expectedId;
    const accountSelfId = resolvedSelfId(pendingBridgeMessages);
    if (!expectedSelfId || accountSelfId !== expectedSelfId) {
      return detailFailure("当前登录账号与补全任务不一致，或无法核验登录账号", {
        identityMismatch: true,
        account_self_id: accountSelfId
      });
    }
    const title = metaContent("meta[property='og:title']")
      || textFrom(document, ["#detail-title", "[class*='note-content'] [class*='title']", "h1"], 1000);
    const description = textFrom(document, [
      "#detail-desc",
      "[class*='note-content'] [class*='desc']",
      "[class*='note-text']"
    ], 100000) || metaContent("meta[name='description']") || metaContent("meta[property='og:description']");
    const authorName = textFrom(document, [
      "[class*='author'] [class*='name']",
      "[class*='user-info'] [class*='name']",
      "[class*='nickname']"
    ], 200);
    const tags = Array.from(document.querySelectorAll("a[href*='/search_result?keyword='], [class*='tag']"))
      .map((element) => (element.textContent || "").replace(/^#/, "").trim().slice(0, 100))
      .filter(Boolean)
      .slice(0, 100);
    const domItem = lib.normalizeItem({
      note_id: noteId,
      title,
      desc: description,
      user: { nickname: authorName },
      cover: metaContent("meta[property='og:image']"),
      tags,
      url: location.href,
      xsec_token: new URL(location.href).searchParams.get("xsec_token") || ""
    }, { mode: "unknown", source: "detail_dom", capturedAt: isoNow() });
    let capturedItem = null;
    let capturedRisk = false;
    let capturedAuthFailure = false;
    for (const message of pendingBridgeMessages.slice().reverse()) {
      if (!message || !message.payload || typeof message.payload !== "object") continue;
      const code = message.payload.code;
      if ([461, 471, -13002, "461", "471", "-13002"].includes(code)) capturedRisk = true;
      if ([401, 403].includes(message.httpStatus)) capturedAuthFailure = true;
      if (message.httpStatus === 429) capturedRisk = true;
      if (message.endpoint !== "initial-state" && !/\/feed(?:\?|$)|\/note\/detail(?:\?|$)/i.test(message.endpoint)) continue;
      const candidates = lib.extractItemsFromPayload(message.payload, {
        mode: "unknown",
        source: message.transport === "ssr" ? "ssr_detail" : "detail_api",
        capturedAt: message.capturedAt || isoNow(),
        maxDepth: 16,
        maxNodes: 50000
      });
      const matching = candidates.find((candidate) => candidate.note_id === noteId);
      if (matching) capturedItem = capturedItem ? lib.mergeItems(capturedItem, matching) : matching;
    }
    if (capturedAuthFailure) {
      return detailFailure("登录状态已失效或无权访问详情页", {
        identityMismatch: true,
        account_self_id: accountSelfId
      });
    }
    if (capturedRisk) return { ok: false, error: "risk_control", riskControl: true, account_self_id: accountSelfId };
    let item = domItem && capturedItem
      ? lib.mergeItems(domItem, capturedItem)
      : domItem || capturedItem;
    if (item && capturedItem) {
      item = Object.assign({}, item, {
        title: capturedItem.title || item.title,
        description: capturedItem.description || item.description,
        note_type: capturedItem.note_type || item.note_type,
        author: {
          id: capturedItem.author && capturedItem.author.id || item.author && item.author.id || "",
          name: capturedItem.author && capturedItem.author.name || item.author && item.author.name || ""
        },
        tags: capturedItem.tags && capturedItem.tags.length ? capturedItem.tags : item.tags
      });
    }
    return item
      ? { ok: true, item, account_self_id: accountSelfId }
      : { ok: false, error: "未提取到详情", account_self_id: accountSelfId };
  }

  async function resolvePageAccountStatus() {
    if (activeRun) return captureStatus();
    const profileId = profileIdFromLocation();
    if (!profileId) return captureStatus();
    if (lastResolvedAccount && lastResolvedAccount.verified && lastResolvedAccount.profile_id === profileId) {
      return captureStatus();
    }
    if (accountProbePromise) return accountProbePromise;
    if (Date.now() - lastAccountProbeAt < 10000) return captureStatus();
    lastAccountProbeAt = Date.now();
    accountProbePromise = (async () => {
      const probeId = crypto.randomUUID();
      bridgeControl("START", probeId);
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      bridgeControl("STOP", probeId);
      const account = currentIdentity(resolvedSelfId(pendingBridgeMessages));
      if (account && account.verified) lastResolvedAccount = account;
      return captureStatus();
    })().finally(() => {
      accountProbePromise = null;
    });
    return accountProbePromise;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "START_CAPTURE") {
      startCapture().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "STOP_CAPTURE") {
      stopCapture("user_stop", false).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "GET_CONTENT_STATUS") {
      resolvePageAccountStatus()
        .then((status) => sendResponse({ ok: true, status }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "EXTRACT_DETAIL") {
      const expectedNoteId = lib.validNoteId(message.expectedNoteId);
      const expectedAccountKey = typeof message.expectedAccountKey === "string" ? message.expectedAccountKey : "";
      const expectedSelfId = /^xhs:[0-9a-zA-Z_-]{8,100}$/.test(expectedAccountKey)
        ? expectedAccountKey.slice(4)
        : "";
      if (!expectedNoteId || !expectedSelfId) {
        sendResponse({ ok: false, error: "补全请求缺少已核验账号或笔记 ID", identityMismatch: true });
        return false;
      }
      const detailRunId = crypto.randomUUID();
      bridgeControl("START", detailRunId);
      window.setTimeout(() => {
        const response = extractDetailFromDom(expectedNoteId, expectedSelfId);
        bridgeControl("STOP", detailRunId);
        sendResponse(response);
      }, 1400);
      return true;
    }
    return false;
  });
})();
