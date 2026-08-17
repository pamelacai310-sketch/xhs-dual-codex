"use strict";

importScripts("lib.js");

const lib = globalThis.XHSDualLib;
const DB_NAME = "xhs-dual-codex";
const DB_VERSION = 1;
const CONTROL_KEY = "xhs.control.v1";
const EXPORT_IDENTITY_KEY = "xhs.export.identity.v1";
const ENRICH_ALARM = "xhs-dual-enrichment";
const EXTENSION_SCHEMA = "xhs-dual-codex/1";
const EXACT_ORIGIN = "https://www.xiaohongshu.com";
const ENRICH_DELAY_MINUTES = 0.5;
const ENRICH_LEASE_MS = 2 * 60 * 1000;
const ENRICH_MAX_RETRIES = 3;

let databasePromise = null;
let captureQueue = Promise.resolve();
let noteMutationQueue = Promise.resolve();
const claimedManagedTabs = new Set();

function enqueue(queueName, operation) {
  const current = queueName === "capture" ? captureQueue : noteMutationQueue;
  const next = current.then(operation, operation);
  if (queueName === "capture") captureQueue = next.catch(() => {});
  else noteMutationQueue = next.catch(() => {});
  return next;
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("notes")) {
        db.createObjectStore("notes", { keyPath: "note_id" });
      }
      if (!db.objectStoreNames.contains("memberships")) {
        const store = db.createObjectStore("memberships", { keyPath: "key" });
        store.createIndex("scope_key", "scope_key", { unique: false });
        store.createIndex("note_id", "note_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("runs")) {
        const store = db.createObjectStore("runs", { keyPath: "run_id" });
        store.createIndex("started_at", "started_at", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地数据库"));
  });
  return databasePromise;
}

async function transaction(storeNames, mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    try {
      result = operation(tx);
    } catch (error) {
      tx.abort();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error("本地数据库写入失败"));
    tx.onabort = () => reject(tx.error || new Error("本地数据库操作已取消"));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("数据库请求失败"));
  });
}

function emptyEnrichment() {
  return {
    status: "idle",
    job_id: "",
    revision: 0,
    scope_key: "",
    account_key: "",
    account_label: "",
    queue: [],
    inflight: null,
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    last_error: "",
    started_at: "",
    updated_at: ""
  };
}

async function getRecord(storeName, key) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readonly");
  return requestResult(tx.objectStore(storeName).get(key));
}

async function getAllRecords(storeName) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readonly");
  return requestResult(tx.objectStore(storeName).getAll());
}

async function countRecords(storeName) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readonly");
  return requestResult(tx.objectStore(storeName).count());
}

async function putRecord(storeName, value) {
  return transaction([storeName], "readwrite", (tx) => {
    tx.objectStore(storeName).put(value);
  });
}

async function recordsForScope(scopeKey) {
  const db = await openDatabase();
  const tx = db.transaction("memberships", "readonly");
  return requestResult(tx.objectStore("memberships").index("scope_key").getAll(scopeKey));
}

async function recordsForNote(noteId) {
  const db = await openDatabase();
  const tx = db.transaction("memberships", "readonly");
  return requestResult(tx.objectStore("memberships").index("note_id").getAll(noteId));
}

async function getControl() {
  const value = await chrome.storage.local.get(CONTROL_KEY);
  return value[CONTROL_KEY] || {
    schema_version: EXTENSION_SCHEMA,
    active_runs: {},
    enrichment: emptyEnrichment()
  };
}

async function setControl(control) {
  control.schema_version = EXTENSION_SCHEMA;
  await chrome.storage.local.set({ [CONTROL_KEY]: control });
}

async function restrictStorageAccess() {
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
}

function validSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab) return false;
  try {
    return new URL(sender.url || sender.tab.url || "").origin === EXACT_ORIGIN;
  } catch (_) {
    return false;
  }
}

function popupSender(sender) {
  return Boolean(sender && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html"));
}

function cleanText(value, maxLength) {
  const text = value === undefined || value === null ? "" : String(value);
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, maxLength);
}

function validRunId(value) {
  return typeof value === "string" && /^[a-f0-9-]{20,80}$/i.test(value);
}

function sanitizeAccount(value) {
  if (!value || typeof value !== "object") return null;
  const verified = value.verified === true;
  const userId = cleanText(value.user_id, 100);
  const profileId = cleanText(value.profile_id, 100);
  if (!/^[0-9a-zA-Z_-]{8,100}$/.test(profileId)) return null;
  let accountKey = cleanText(value.account_key, 180);
  if (verified) {
    if (!/^[0-9a-zA-Z_-]{8,100}$/.test(userId) || userId !== profileId || accountKey !== `xhs:${userId}`) return null;
  } else if (!/^unverified:[a-f0-9-]{20,80}$/i.test(accountKey)) {
    return null;
  }
  return {
    account_key: accountKey,
    user_id: userId,
    profile_id: profileId,
    label: cleanText(value.label, 200) || "未命名账号",
    verified
  };
}

function senderPage(sender) {
  try {
    const url = new URL(sender.url || sender.tab.url || "");
    const match = url.pathname.match(/^\/user\/profile\/([0-9a-zA-Z_-]{8,100})/i);
    const tab = (url.searchParams.get("tab") || "").toLowerCase();
    const mode = ["liked", "like", "likes"].includes(tab)
      ? "liked"
      : ["fav", "collect", "collected", "collection", "favorite", "favorites"].includes(tab)
        ? "collected"
        : "unknown";
    return { profile_id: match ? match[1] : "", mode };
  } catch (_) {
    return { profile_id: "", mode: "unknown" };
  }
}

function senderMatchesRun(sender, run) {
  const page = senderPage(sender);
  if (page.profile_id !== run.account.profile_id || page.mode !== run.mode) return false;
  if (run.document_id && sender.documentId && run.document_id !== sender.documentId) return false;
  return true;
}

function scopeKey(accountKey, mode) {
  return `${accountKey}|${mode}`;
}

function membershipKey(scope, noteId) {
  return `${scope}|${noteId}`;
}

function sanitizeEndpoint(value) {
  const path = cleanText(value, 500);
  return /^\/api\/sns\/web\/v\d+\//.test(path) || /^\/user\/profile\//.test(path) ? path.split("?")[0] : "";
}

function expectedListingEndpoint(path, mode) {
  if (mode === "liked") return /^\/api\/sns\/web\/v\d+\/note\/(?:like|likes)\/page$/i.test(path);
  if (mode === "collected") return /^\/api\/sns\/web\/v\d+\/note\/(?:collect|collection|favorite|favorites)\/page$/i.test(path);
  return false;
}

function sanitizeIncomingItem(raw, mode, transport, capturedAt) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = lib.normalizeItem(raw, {
    mode,
    source: cleanText(transport, 20),
    capturedAt: cleanText(capturedAt, 100) || new Date().toISOString()
  });
  if (!item) return null;
  item.title = cleanText(item.title, 1000);
  item.description = cleanText(item.description, 100000);
  item.note_type = cleanText(item.note_type, 100);
  item.cover_url = cleanText(item.cover_url, 5000);
  item.author = {
    id: cleanText(item.author && item.author.id, 100),
    name: cleanText(item.author && item.author.name, 200)
  };
  item.tags = Array.isArray(item.tags) ? item.tags.map((tag) => cleanText(tag, 100)).filter(Boolean).slice(0, 100) : [];
  item.xsec_token = cleanText(item.xsec_token, 2048);
  item.url = lib.noteUrl(item.note_id, item.xsec_token);
  item.safe_url = lib.noteUrl(item.note_id, "");
  return item;
}

function safeNoteFromItem(item) {
  let safeCover = "";
  try {
    const cover = new URL(item.cover_url || "");
    if (cover.protocol === "https:" || cover.protocol === "http:") {
      cover.username = "";
      cover.password = "";
      cover.search = "";
      cover.hash = "";
      safeCover = cover.href;
    }
  } catch (_) {
    safeCover = "";
  }
  return {
    note_id: item.note_id,
    title: item.title,
    description: item.description,
    author: item.author,
    note_type: item.note_type,
    cover_url: safeCover,
    liked_count: item.liked_count,
    tags: item.tags,
    safe_url: lib.noteUrl(item.note_id, ""),
    sources: item.sources || [],
    first_captured_at: item.captured_at,
    captured_at: item.captured_at
  };
}

function mergeSafeNote(previous, incoming) {
  const merged = lib.mergeItems(previous || {}, incoming || {});
  delete merged.xsec_token;
  delete merged.url;
  merged.safe_url = lib.noteUrl(merged.note_id, "");
  merged.first_captured_at = previous && previous.first_captured_at
    ? previous.first_captured_at
    : incoming.first_captured_at || incoming.captured_at;
  return merged;
}

async function upsertItemsInternal(items, account, mode, transport, capturedAt) {
  const scope = scopeKey(account.account_key, mode);
  const unique = new Map();
  for (const raw of items.slice(0, 250)) {
    const item = sanitizeIncomingItem(raw, mode, transport, capturedAt);
    if (item) unique.set(item.note_id, unique.has(item.note_id) ? lib.mergeItems(unique.get(item.note_id), item) : item);
  }
  if (!unique.size) return { accepted: 0, scope_key: scope };

  const noteIds = Array.from(unique.keys());
  const previousNotes = await Promise.all(noteIds.map((id) => getRecord("notes", id)));
  const previousMemberships = await Promise.all(noteIds.map((id) => getRecord("memberships", membershipKey(scope, id))));
  await transaction(["notes", "memberships"], "readwrite", (tx) => {
    const noteStore = tx.objectStore("notes");
    const memberStore = tx.objectStore("memberships");
    noteIds.forEach((noteId, index) => {
      const item = unique.get(noteId);
      const safeIncoming = safeNoteFromItem(item);
      noteStore.put(mergeSafeNote(previousNotes[index], safeIncoming));
      const previous = previousMemberships[index] || {};
      memberStore.put({
        key: membershipKey(scope, noteId),
        scope_key: scope,
        note_id: noteId,
        account_key: account.account_key,
        account_label: account.label,
        account_verified: account.verified,
        mode,
        xsec_token: item.xsec_token || previous.xsec_token || "",
        private_url: lib.noteUrl(noteId, item.xsec_token || previous.xsec_token || ""),
        first_captured_at: previous.first_captured_at || item.captured_at,
        captured_at: item.captured_at,
        sources: Array.from(new Set([...(previous.sources || []), ...(item.sources || [])])).slice(0, 20)
      });
    });
  });
  return { accepted: unique.size, scope_key: scope };
}

async function startRun(message, sender) {
  if (!validSender(sender)) return { ok: false, error: "无效的页面来源" };
  if (!validRunId(message.runId)) return { ok: false, error: "无效的采集任务" };
  if (!["liked", "collected"].includes(message.mode)) return { ok: false, error: "无法确认收藏或赞过栏目" };
  const account = sanitizeAccount(message.account);
  if (!account) return { ok: false, error: "无法确认账号" };
  const page = senderPage(sender);
  if (page.profile_id !== account.profile_id || page.mode !== message.mode) {
    return { ok: false, error: "页面地址与采集账号或栏目不一致，请刷新后重试" };
  }
  const tabId = sender.tab.id;
  const control = await getControl();
  const existing = control.active_runs[String(tabId)];
  if (existing && existing.run_id !== message.runId) {
    existing.status = "finished";
    existing.complete = false;
    existing.completeness = "partial";
    existing.stop_reason = "restarted_after_navigation";
    existing.finished_at = new Date().toISOString();
    await putRecord("runs", existing);
  }

  const run = {
    run_id: message.runId,
    tab_id: tabId,
    document_id: cleanText(sender.documentId, 100),
    account,
    mode: message.mode,
    scope_key: scopeKey(account.account_key, message.mode),
    started_at: cleanText(message.startedAt, 100) || new Date().toISOString(),
    finished_at: "",
    status: "running",
    completeness: "unknown",
    complete: false,
    api_pages: 0,
    first_page_seen: false,
    terminal_page_seen: false,
    pagination_continuous: true,
    expected_request_cursor: "",
    request_cursors_seen: [],
    list_page_keys: [],
    source_counts: {},
    cursor_chain: [],
    last_has_more: null,
    last_endpoint: "",
    last_error: "",
    raw_items_seen: 0,
    accepted_items: 0,
    stop_reason: ""
  };
  control.active_runs[String(tabId)] = run;
  await setControl(control);
  await putRecord("runs", run);
  return { ok: true, run };
}

async function activeRunFor(message, sender) {
  if (!validSender(sender) || !validRunId(message.runId)) return null;
  const control = await getControl();
  const run = control.active_runs[String(sender.tab.id)];
  if (!run || run.run_id !== message.runId || run.status !== "running" || !senderMatchesRun(sender, run)) return null;
  return { control, run };
}

async function recordListPage(message, sender) {
  const active = await activeRunFor(message, sender);
  if (!active) return { ok: false, error: "采集任务未启动、页面已变化或任务已失效" };
  const account = sanitizeAccount(message.account);
  if (!account || account.account_key !== active.run.account.account_key || message.mode !== active.run.mode) {
    return { ok: false, error: "账号或栏目在采集中发生变化" };
  }
  const endpoint = sanitizeEndpoint(message.endpoint);
  if (!["xhr", "fetch"].includes(message.transport) || !expectedListingEndpoint(endpoint, active.run.mode)) {
    return { ok: false, error: "不是当前栏目的列表接口" };
  }
  const httpStatus = Number(message.httpStatus);
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
    return { ok: false, error: "列表错误响应不能计入分页完整性" };
  }
  const requestCursor = cleanText(message.requestCursor, 2048);
  const nextCursor = cleanText(message.nextCursor, 2048);
  const itemCount = Number(message.itemCount);
  const hasMore = message.hasMore;
  if (!Number.isInteger(itemCount) || itemCount < 0 || itemCount > 5000 || typeof hasMore !== "boolean") {
    return { ok: false, error: "分页字段不完整" };
  }

  const run = active.run;
  if (run.request_cursors_seen.includes(requestCursor)) {
    run.cursor_repeated = true;
    run.pagination_continuous = false;
    run.last_error = "请求 cursor 重复，无法证明数据完整";
  } else {
    if (run.api_pages === 0) {
      run.first_page_seen = requestCursor === "";
      if (!run.first_page_seen) {
        run.pagination_continuous = false;
        run.last_error = "采集开始前的第一页未被捕获";
      }
    } else if (requestCursor !== run.expected_request_cursor) {
      run.pagination_continuous = false;
      run.last_error = "分页 cursor 不连续，可能漏页";
    }
    if (run.terminal_page_seen) {
      run.pagination_continuous = false;
      run.last_error = "终止页之后又出现列表响应";
    }
    if (hasMore && !nextCursor) {
      run.pagination_continuous = false;
      run.last_error = "接口表示仍有下一页，但没有返回 next cursor";
    }
    run.request_cursors_seen.push(requestCursor);
    run.request_cursors_seen = run.request_cursors_seen.slice(-5000);
    run.cursor_chain.push(nextCursor);
    run.cursor_chain = run.cursor_chain.slice(-5000);
    run.expected_request_cursor = nextCursor;
    run.api_pages += 1;
    run.last_has_more = hasMore;
    run.terminal_page_seen = hasMore === false;
    run.last_endpoint = endpoint;
    run.last_page_item_count = itemCount;
    run.last_event_at = new Date().toISOString();
  }
  active.control.active_runs[String(sender.tab.id)] = run;
  await setControl(active.control);
  await putRecord("runs", run);
  return { ok: true, duplicate: run.cursor_repeated === true };
}

async function handleUpsert(message, sender) {
  const active = await activeRunFor(message, sender);
  if (!active) return { ok: false, error: "采集任务未启动或已失效" };
  if (!Array.isArray(message.items) || message.items.length > 250) return { ok: false, error: "数据批次过大" };
  const account = sanitizeAccount(message.account);
  if (!account || account.account_key !== active.run.account.account_key || message.mode !== active.run.mode) {
    return { ok: false, error: "账号或栏目在采集中发生变化" };
  }
  const transport = ["xhr", "fetch", "ssr", "dom", "detail_dom", "api"].includes(message.transport)
    ? message.transport
    : "unknown";
  const cleanEndpoint = sanitizeEndpoint(message.endpoint);
  if (["xhr", "fetch"].includes(transport) && !expectedListingEndpoint(cleanEndpoint, active.run.mode)) {
    return { ok: false, error: "列表采集拒绝了非列表接口数据" };
  }
  if (transport === "dom" && !/^\/user\/profile\//.test(cleanEndpoint)) {
    return { ok: false, error: "DOM 数据不来自个人列表页" };
  }
  if (active.run.raw_items_seen + message.items.length > 200000) {
    active.run.last_error = "单次任务超过 200000 条安全上限";
    active.run.pagination_continuous = false;
    active.control.active_runs[String(sender.tab.id)] = active.run;
    await setControl(active.control);
    await putRecord("runs", active.run);
    return { ok: false, error: active.run.last_error };
  }
  const result = await enqueue("notes", () => upsertItemsInternal(
    message.items,
    account,
    message.mode,
    transport,
    message.capturedAt
  ));
  const run = active.run;
  run.raw_items_seen += message.items.length;
  run.accepted_items += result.accepted;
  run.source_counts[transport] = (run.source_counts[transport] || 0) + result.accepted;
  run.last_endpoint = cleanEndpoint;
  run.last_event_at = new Date().toISOString();
  active.control.active_runs[String(sender.tab.id)] = run;
  await setControl(active.control);
  await putRecord("runs", run);
  return { ok: true, accepted: result.accepted };
}

async function updateRun(message, sender) {
  const active = await activeRunFor(message, sender);
  if (!active) return { ok: false, error: "采集任务未启动" };
  const status = message.status && typeof message.status === "object" ? message.status : {};
  active.run.last_error = cleanText(status.last_error, 500) || active.run.last_error;
  active.run.last_ui_event_at = cleanText(status.last_event_at || status.last_scroll_at, 100);
  active.control.active_runs[String(sender.tab.id)] = active.run;
  await setControl(active.control);
  await putRecord("runs", active.run);
  return { ok: true };
}

async function finishRun(message, sender) {
  const active = await activeRunFor(message, sender);
  if (!active) return { ok: false, error: "采集任务未启动" };
  const result = message.result && typeof message.result === "object" ? message.result : {};
  const run = active.run;
  run.finished_at = cleanText(result.finished_at, 100) || new Date().toISOString();
  run.stop_reason = cleanText(result.stop_reason, 100) || "unknown";
  run.status = "finished";
  const apiTerminal = run.api_pages > 0
    && run.first_page_seen
    && run.pagination_continuous
    && run.terminal_page_seen
    && run.last_has_more === false;
  const noRunError = !run.last_error && !run.cursor_repeated && !["risk_control", "account_changed", "mode_changed", "stalled_has_more"].includes(run.stop_reason);
  run.complete = Boolean(apiTerminal && run.account.verified && noRunError);
  run.completeness = run.complete ? "complete" : "partial";
  const scopeMembers = await recordsForScope(run.scope_key);
  const scopeNotes = await Promise.all(scopeMembers.map((member) => getRecord("notes", member.note_id)));
  run.unique_items = scopeMembers.length;
  run.duplicate_events = Math.max(0, run.raw_items_seen - run.unique_items);
  run.missing_title_count = scopeNotes.filter((note) => !note || !note.title).length;
  run.missing_author_count = scopeNotes.filter((note) => !note || !note.author || !note.author.name).length;
  run.missing_detail_count = scopeNotes.filter((note) => !note || !note.description).length;
  run.missing_token_count = scopeMembers.filter((member) => !member.xsec_token).length;
  delete active.control.active_runs[String(sender.tab.id)];
  await setControl(active.control);
  await putRecord("runs", run);
  return { ok: true, run };
}

async function summary() {
  const [noteCount, memberCount, memberships, runs, notes, control] = await Promise.all([
    countRecords("notes"),
    countRecords("memberships"),
    getAllRecords("memberships"),
    getAllRecords("runs"),
    getAllRecords("notes"),
    getControl()
  ]);
  const scopes = {};
  for (const member of memberships) {
    if (!scopes[member.scope_key]) {
      scopes[member.scope_key] = {
        scope_key: member.scope_key,
        account_key: member.account_key,
        account_label: member.account_label,
        account_verified: member.account_verified,
        mode: member.mode,
        item_count: 0,
        missing_token_count: 0
      };
    }
    scopes[member.scope_key].item_count += 1;
    if (!member.xsec_token) scopes[member.scope_key].missing_token_count += 1;
  }
  const missingDescription = notes.filter((note) => !note.description).length;
  const recentRuns = runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, 20);
  return {
    ok: true,
    schema_version: EXTENSION_SCHEMA,
    note_count: noteCount,
    membership_count: memberCount,
    missing_description_count: missingDescription,
    scopes: Object.values(scopes),
    active_runs: Object.values(control.active_runs || {}),
    recent_runs: recentRuns,
    enrichment: publicEnrichment(control.enrichment)
  };
}

function safeMembership(member, accountAlias) {
  return {
    account_key: accountAlias,
    account_label: accountAlias,
    account_verified: member.account_verified,
    mode: member.mode,
    safe_url: lib.noteUrl(member.note_id, ""),
    first_captured_at: member.first_captured_at,
    captured_at: member.captured_at,
    sources: member.sources
  };
}

function sanitizedRun(run, aliases) {
  const alias = aliases.get(run.account && run.account.account_key) || "account-unknown";
  return {
    run_id: run.run_id,
    account: { account_key: alias, label: alias, verified: Boolean(run.account && run.account.verified) },
    mode: run.mode,
    started_at: run.started_at,
    finished_at: run.finished_at,
    status: run.status,
    completeness: run.completeness,
    complete: Boolean(run.complete),
    api_pages: run.api_pages || 0,
    first_page_seen: Boolean(run.first_page_seen),
    terminal_page_seen: Boolean(run.terminal_page_seen),
    pagination_continuous: Boolean(run.pagination_continuous),
    last_has_more: typeof run.last_has_more === "boolean" ? run.last_has_more : null,
    source_counts: run.source_counts || {},
    raw_items_seen: run.raw_items_seen || 0,
    unique_items: run.unique_items || 0,
    duplicate_events: run.duplicate_events || 0,
    missing_title_count: run.missing_title_count || 0,
    missing_author_count: run.missing_author_count || 0,
    missing_detail_count: run.missing_detail_count || 0,
    missing_token_count: run.missing_token_count || 0,
    stop_reason: run.stop_reason || "",
    last_error: run.last_error || ""
  };
}

async function getOrCreateExportIdentity(accountKeys) {
  const stored = await chrome.storage.local.get(EXPORT_IDENTITY_KEY);
  const previous = stored[EXPORT_IDENTITY_KEY];
  const validNamespace = previous && /^profile-[a-f0-9-]{20,80}$/i.test(previous.profile_namespace || "")
    ? previous.profile_namespace
    : `profile-${crypto.randomUUID()}`;
  const previousAliases = previous && previous.account_aliases && typeof previous.account_aliases === "object"
    ? previous.account_aliases
    : {};
  const accountAliases = {};
  let changed = !previous || validNamespace !== previous.profile_namespace;
  for (const accountKey of accountKeys) {
    const existing = cleanText(previousAliases[accountKey], 100);
    if (/^account-[a-f0-9-]{20,80}$/i.test(existing)) accountAliases[accountKey] = existing;
    else {
      accountAliases[accountKey] = `account-${crypto.randomUUID()}`;
      changed = true;
    }
  }
  for (const [accountKey, alias] of Object.entries(previousAliases)) {
    if (accountAliases[accountKey] || !/^account-[a-f0-9-]{20,80}$/i.test(alias)) continue;
    accountAliases[accountKey] = alias;
  }
  const identity = { profile_namespace: validNamespace, account_aliases: accountAliases };
  if (changed || Object.keys(accountAliases).length !== Object.keys(previousAliases).length) {
    await chrome.storage.local.set({ [EXPORT_IDENTITY_KEY]: identity });
  }
  return {
    profile_namespace: validNamespace,
    aliases: new Map(Object.entries(accountAliases))
  };
}

async function buildExport(privateMode) {
  const [notes, memberships, runs] = await Promise.all([
    getAllRecords("notes"),
    getAllRecords("memberships"),
    getAllRecords("runs")
  ]);
  const accountKeys = Array.from(new Set([
    ...memberships.map((member) => member.account_key),
    ...runs.map((run) => run.account && run.account.account_key).filter(Boolean)
  ])).sort();
  const exportIdentity = await getOrCreateExportIdentity(accountKeys);
  const aliases = exportIdentity.aliases;
  const byNote = new Map();
  for (const member of memberships) {
    if (!byNote.has(member.note_id)) byNote.set(member.note_id, []);
    const exportMember = privateMode
      ? safeMembership(member, member.account_key)
      : safeMembership(member, aliases.get(member.account_key) || "account-unknown");
    if (privateMode) exportMember.account_label = member.account_label;
    if (privateMode) {
      exportMember.xsec_token = member.xsec_token;
      exportMember.private_url = lib.noteUrl(member.note_id, member.xsec_token);
    }
    byNote.get(member.note_id).push(exportMember);
  }
  const items = notes.map((note) => {
    const itemMemberships = byNote.get(note.note_id) || [];
    const base = privateMode ? Object.assign({}, note) : {
      note_id: note.note_id,
      title: note.title || "",
      description: note.description || "",
      author: note.author || { id: "", name: "" },
      note_type: note.note_type || "",
      liked_count: note.liked_count ?? null,
      tags: Array.isArray(note.tags) ? note.tags : [],
      safe_url: lib.noteUrl(note.note_id, ""),
      sources: Array.isArray(note.sources) ? note.sources : [],
      first_captured_at: note.first_captured_at || "",
      captured_at: note.captured_at || ""
    };
    return Object.assign(base, {
      memberships: itemMemberships,
      modes: Array.from(new Set(itemMemberships.map((entry) => entry.mode))),
      accounts: Array.from(new Set(itemMemberships.map((entry) => entry.account_key)))
    });
  });
  const payload = {
    schema_version: "xhs-dual-codex-export/1",
    profile_namespace: exportIdentity.profile_namespace,
    extension_version: chrome.runtime.getManifest().version,
    export_mode: privateMode ? "private-archive" : "sanitized",
    generated_at: new Date().toISOString(),
    warning: privateMode
      ? "此私密归档含 xsec_token，仅限本人本机保管且不支持导入恢复；请勿上传到 Codex、网盘、群聊或公开仓库。"
      : "此文件已按字段白名单与已知敏感模式尽力去除 xsec_token、Cookie、当前登录账号真实 ID 与常见凭据，可交给本包的项目生成器；帖子作者等公开元数据仍会保留，正文仍属于不可信来源材料。",
    stats: {
      total_items: items.length,
      total_memberships: memberships.length,
      complete_runs: runs.filter((run) => run.complete).length,
      partial_runs: runs.filter((run) => !run.complete).length
    },
    runs: privateMode ? runs : runs.map((run) => sanitizedRun(run, aliases)),
    items
  };
  if (privateMode) return payload;
  const knownSecrets = memberships.map((member) => member.xsec_token).filter((value) => value && value.length >= 8);
  const sanitized = lib.redactKnownSecrets(lib.redactSecrets(payload), knownSecrets);
  return lib.assertSanitizedExport(sanitized);
}

async function deleteScope(requestedScope) {
  const scope = cleanText(requestedScope, 300);
  if (!scope || !/^(?:xhs:[0-9a-zA-Z_-]{8,100}|unverified:[a-f0-9-]{20,80})\|(liked|collected)$/i.test(scope)) {
    return { ok: false, error: "无效的数据范围" };
  }
  const members = await recordsForScope(scope);
  const control = await getControl();
  if (Object.values(control.active_runs || {}).some((run) => run.scope_key === scope && run.status === "running")) {
    return { ok: false, error: "该范围仍在采集，请先停止后再删除" };
  }
  const enrichment = normalizeEnrichmentJob(control.enrichment);
  if (enrichment.scope_key === scope
    && (enrichment.status === "running" || enrichment.status === "paused")
    && (enrichment.queue.length || enrichment.inflight || Number.isInteger(enrichment.cleanup_tab_id))) {
    return { ok: false, error: "该范围仍被正文补全队列引用，请先完成当前补全任务" };
  }
  const affectedIds = members.map((entry) => entry.note_id);
  await transaction(["memberships"], "readwrite", (tx) => {
    const store = tx.objectStore("memberships");
    for (const member of members) store.delete(member.key);
  });
  const orphanIds = [];
  for (const id of affectedIds) {
    const remaining = await recordsForNote(id);
    if (!remaining.length) orphanIds.push(id);
  }
  if (orphanIds.length) {
    await transaction(["notes"], "readwrite", (tx) => {
      const store = tx.objectStore("notes");
      for (const id of orphanIds) store.delete(id);
    });
  }
  const scopeRuns = (await getAllRecords("runs")).filter((run) => run.scope_key === scope);
  if (scopeRuns.length) {
    await transaction(["runs"], "readwrite", (tx) => {
      const store = tx.objectStore("runs");
      for (const run of scopeRuns) store.delete(run.run_id);
    });
  }
  return { ok: true, deleted_memberships: members.length, deleted_orphan_notes: orphanIds.length, deleted_runs: scopeRuns.length };
}

async function purgeTokens(requestedScope) {
  const scope = cleanText(requestedScope, 300);
  const control = await getControl();
  const activeRuns = Object.values(control.active_runs || {});
  if (activeRuns.some((run) => run.status === "running" && (!scope || run.scope_key === scope))) {
    return { ok: false, error: "相关范围仍在采集，请先停止" };
  }
  if (control.enrichment && control.enrichment.status === "running") {
    return { ok: false, error: "正文补全仍在运行，请先暂停" };
  }
  const enrichment = normalizeEnrichmentJob(control.enrichment);
  if ((enrichment.status === "paused" || enrichment.status === "running")
    && (enrichment.queue.length || enrichment.inflight || Number.isInteger(enrichment.cleanup_tab_id))
    && (!scope || enrichment.scope_key === scope)) {
    return { ok: false, error: "该范围仍在正文补全队列中；完成任务后才能清除令牌" };
  }
  const members = scope ? await recordsForScope(scope) : await getAllRecords("memberships");
  const withTokens = members.filter((member) => member.xsec_token);
  if (withTokens.length) {
    await transaction(["memberships"], "readwrite", (tx) => {
      const store = tx.objectStore("memberships");
      for (const member of withTokens) {
        store.put(Object.assign({}, member, {
          xsec_token: "",
          private_url: lib.noteUrl(member.note_id, "")
        }));
      }
    });
  }
  return { ok: true, purged: withTokens.length };
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function normalizeEnrichmentJob(rawJob) {
  const job = rawJob && typeof rawJob === "object" ? rawJob : emptyEnrichment();
  job.status = ["idle", "running", "paused", "complete"].includes(job.status) ? job.status : "idle";
  job.job_id = cleanText(job.job_id, 100) || crypto.randomUUID();
  job.revision = Number.isInteger(job.revision) && job.revision >= 0 ? job.revision : 0;
  job.scope_key = cleanText(job.scope_key, 300);
  job.account_key = cleanText(job.account_key, 180)
    || (/^xhs:[0-9a-zA-Z_-]{8,100}\|/.test(job.scope_key) ? job.scope_key.split("|")[0] : "");
  job.account_label = cleanText(job.account_label, 200);
  job.queue = Array.isArray(job.queue)
    ? job.queue.map((entry) => ({
        note_id: lib.validNoteId(entry && entry.note_id),
        membership_key: cleanText(entry && entry.membership_key, 500),
        attempts: Number.isInteger(entry && entry.attempts) && entry.attempts >= 0 ? entry.attempts : 0
      })).filter((entry) => entry.note_id && entry.membership_key)
    : [];
  if (!job.inflight && Number.isInteger(job.current_tab_id) && lib.validNoteId(job.current_note_id)) {
    const noteId = lib.validNoteId(job.current_note_id);
    const membership = `${job.scope_key}|${noteId}`;
    if (!job.queue.some((entry) => entry.note_id === noteId)) {
      job.queue.unshift({ note_id: noteId, membership_key: membership, attempts: 1 });
    }
    job.inflight = {
      lease_id: crypto.randomUUID(),
      note_id: noteId,
      membership_key: membership,
      phase: "loading",
      tab_id: job.current_tab_id,
      attempt: job.queue[0].attempts || 1,
      lease_started_at: Date.now(),
      lease_expires_at: Date.now() + ENRICH_LEASE_MS
    };
  }
  delete job.current_tab_id;
  delete job.current_note_id;
  if (job.inflight && typeof job.inflight === "object") {
    const inflight = job.inflight;
    inflight.note_id = lib.validNoteId(inflight.note_id);
    inflight.membership_key = cleanText(inflight.membership_key, 500);
    inflight.phase = ["opening", "loading", "extracting"].includes(inflight.phase) ? inflight.phase : "loading";
    inflight.tab_id = Number.isInteger(inflight.tab_id) ? inflight.tab_id : null;
    inflight.attempt = Number.isInteger(inflight.attempt) && inflight.attempt > 0 ? inflight.attempt : 1;
    inflight.lease_started_at = Number.isFinite(inflight.lease_started_at) ? inflight.lease_started_at : Date.now();
    inflight.lease_expires_at = Number.isFinite(inflight.lease_expires_at)
      ? inflight.lease_expires_at
      : Date.now() + ENRICH_LEASE_MS;
    if (!inflight.note_id || !inflight.membership_key) job.inflight = null;
  } else {
    job.inflight = null;
  }
  job.total = Number.isInteger(job.total) && job.total >= 0 ? job.total : job.queue.length;
  job.completed = Number.isInteger(job.completed) && job.completed >= 0 ? job.completed : 0;
  job.failed = Number.isInteger(job.failed) && job.failed >= 0 ? job.failed : 0;
  job.skipped = Number.isInteger(job.skipped) && job.skipped >= 0 ? job.skipped : 0;
  job.last_error = cleanText(job.last_error, 500);
  job.cleanup_tab_id = Number.isInteger(job.cleanup_tab_id) ? job.cleanup_tab_id : null;
  return job;
}

function publicEnrichment(jobValue) {
  const job = normalizeEnrichmentJob(jobValue);
  return {
    status: job.status,
    scope_key: job.scope_key,
    account_key: job.account_key,
    account_label: job.account_label,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    skipped: job.skipped,
    remaining: job.queue.length,
    current_note_id: job.inflight ? job.inflight.note_id : "",
    phase: job.inflight ? job.inflight.phase : "",
    attempt: job.inflight ? job.inflight.attempt : 0,
    last_error: job.last_error,
    started_at: job.started_at || "",
    updated_at: job.updated_at || ""
  };
}

function verifiedScope(scope, currentAccountKey) {
  const cleanScope = cleanText(scope, 300);
  const accountKey = cleanText(currentAccountKey, 180);
  const match = cleanScope.match(/^(xhs:[0-9a-zA-Z_-]{8,100})\|(liked|collected)$/);
  if (!match || match[1] !== accountKey) return null;
  return { scope_key: cleanScope, account_key: accountKey, mode: match[2] };
}

function effectiveManagedTabUrl(changeInfo, tab) {
  return lib.firstHttpUrl(
    changeInfo && changeInfo.url,
    tab && tab.pendingUrl,
    tab && tab.url
  );
}

async function scheduleEnrichmentAlarm() {
  await chrome.alarms.create(ENRICH_ALARM, { delayInMinutes: ENRICH_DELAY_MINUTES });
}

async function closeManagedTabUnlessClaimed(tabId) {
  if (!Number.isInteger(tabId) || claimedManagedTabs.has(tabId)) return false;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return true;
  }
  if (tab.active || claimedManagedTabs.has(tabId)) return false;
  try {
    await chrome.tabs.remove(tabId);
    claimedManagedTabs.delete(tabId);
    return true;
  } catch (_) {
    return false;
  }
}

async function persistEnrichment(control, job) {
  job.revision += 1;
  job.updated_at = new Date().toISOString();
  control.enrichment = job;
  await setControl(control);
}

async function pauseJob(control, job, reason, retainedTabId) {
  job.status = "paused";
  job.last_error = cleanText(reason, 500) || job.last_error;
  if (Number.isInteger(retainedTabId)) job.retained_tab_id = retainedTabId;
  if (job.cleanup_tab_id === retainedTabId) job.cleanup_tab_id = null;
  job.inflight = null;
  await persistEnrichment(control, job);
  await chrome.alarms.clear(ENRICH_ALARM);
  return { ok: true, enrichment: publicEnrichment(job) };
}

async function persistAndSchedule(control, job) {
  if (!job.queue.length && !Number.isInteger(job.cleanup_tab_id)) {
    job.status = "complete";
    job.inflight = null;
  }
  await persistEnrichment(control, job);
  if (job.status === "running") await scheduleEnrichmentAlarm();
  else await chrome.alarms.clear(ENRICH_ALARM);
}

async function startEnrichment(scope, currentAccountKey) {
  const selected = verifiedScope(scope, currentAccountKey);
  if (!selected) return { ok: false, error: "只能选择当前已核验账号的一个收藏或赞过栏目" };
  const control = await getControl();
  const existing = normalizeEnrichmentJob(control.enrichment);
  if (existing.status === "running") {
    if (existing.scope_key !== selected.scope_key || existing.account_key !== selected.account_key) {
      return { ok: false, error: "另一账号或栏目正在补全，请先暂停" };
    }
    await scheduleEnrichmentAlarm();
    return { ok: true, enrichment: publicEnrichment(existing) };
  }
  if (existing.status === "paused"
    && existing.scope_key === selected.scope_key
    && existing.account_key === selected.account_key
    && (existing.queue.length || Number.isInteger(existing.cleanup_tab_id))) {
    existing.status = "running";
    existing.inflight = null;
    existing.last_error = "";
    delete existing.retained_tab_id;
    await persistAndSchedule(control, existing);
    return { ok: true, enrichment: publicEnrichment(existing) };
  }

  const [notes, memberships] = await Promise.all([
    getAllRecords("notes"),
    recordsForScope(selected.scope_key)
  ]);
  if (!memberships.length) return { ok: false, error: "所选栏目没有可补全的数据" };
  if (memberships.some((member) => member.account_key !== selected.account_key || member.account_verified !== true)) {
    return { ok: false, error: "所选栏目不是当前已核验账号的数据" };
  }
  const noteMap = new Map(notes.map((note) => [note.note_id, note]));
  const queue = memberships
    .filter((member) => {
      const note = noteMap.get(member.note_id);
      return note && !note.description;
    })
    .map((member) => ({ note_id: member.note_id, membership_key: member.key, attempts: 0 }));
  const now = new Date().toISOString();
  const job = Object.assign(emptyEnrichment(), {
    status: queue.length ? "running" : "complete",
    job_id: crypto.randomUUID(),
    revision: 0,
    scope_key: selected.scope_key,
    account_key: selected.account_key,
    account_label: memberships[0].account_label,
    queue,
    total: queue.length,
    started_at: now,
    updated_at: now
  });
  await persistAndSchedule(control, job);
  return { ok: true, enrichment: publicEnrichment(job) };
}

async function pauseEnrichment(reason) {
  const control = await getControl();
  const job = normalizeEnrichmentJob(control.enrichment);
  if (job.status !== "running") return { ok: true, enrichment: publicEnrichment(job) };
  const managedTabId = job.inflight && Number.isInteger(job.inflight.tab_id)
    ? job.inflight.tab_id
    : Number.isInteger(job.cleanup_tab_id)
      ? job.cleanup_tab_id
      : null;
  if (!Number.isInteger(managedTabId)) return pauseJob(control, job, reason, null);

  let tab = null;
  try { tab = await chrome.tabs.get(managedTabId); } catch (_) { tab = null; }
  if (tab && (tab.active || claimedManagedTabs.has(managedTabId))) {
    return pauseJob(control, job, reason, managedTabId);
  }
  if (!tab) return pauseJob(control, job, reason, null);

  job.status = "paused";
  job.last_error = cleanText(reason, 500) || job.last_error;
  job.inflight = null;
  job.cleanup_tab_id = managedTabId;
  delete job.retained_tab_id;
  await persistEnrichment(control, job);
  await chrome.alarms.clear(ENRICH_ALARM);

  const closed = await closeManagedTabUnlessClaimed(managedTabId);
  if (closed) {
    job.cleanup_tab_id = null;
    await persistEnrichment(control, job);
  } else {
    let latestTab = null;
    try { latestTab = await chrome.tabs.get(managedTabId); } catch (_) { latestTab = null; }
    if (latestTab && (latestTab.active || claimedManagedTabs.has(managedTabId))) {
      job.cleanup_tab_id = null;
      job.retained_tab_id = managedTabId;
      await persistEnrichment(control, job);
    }
  }
  return { ok: true, enrichment: publicEnrichment(job) };
}

async function terminalQueueEntry(control, job, field, error) {
  job.queue.shift();
  job[field] += 1;
  job.inflight = null;
  job.last_error = cleanText(error, 500) || job.last_error;
  await persistAndSchedule(control, job);
}

async function transientEnrichmentFailure(control, job, error, tabId) {
  const attemptAlreadyCounted = Boolean(job.inflight);
  if (Number.isInteger(tabId)) {
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (_) { tab = null; }
    if ((tab && tab.active) || claimedManagedTabs.has(tabId)) {
      return pauseJob(control, job, "你已打开补全标签页；任务已暂停且不会自动关闭该页。", tabId);
    }
  }
  const head = job.queue[0];
  job.inflight = null;
  job.last_error = cleanText(error, 500) || "正文补全失败";
  if (head && !attemptAlreadyCounted) head.attempts += 1;
  if (head && head.attempts >= ENRICH_MAX_RETRIES) {
    job.queue.shift();
    job.failed += 1;
  }
  if (Number.isInteger(tabId)) job.cleanup_tab_id = tabId;
  await persistAndSchedule(control, job);
  if (Number.isInteger(tabId) && await closeManagedTabUnlessClaimed(tabId)) {
    job.cleanup_tab_id = null;
    await persistAndSchedule(control, job);
  }
  return { ok: false, error: job.last_error };
}

async function runEnrichmentTick() {
  const control = await getControl();
  const job = normalizeEnrichmentJob(control.enrichment);
  control.enrichment = job;
  if (job.status !== "running") {
    await chrome.alarms.clear(ENRICH_ALARM);
    return;
  }
  if (Number.isInteger(job.cleanup_tab_id)) {
    const cleanupTabId = job.cleanup_tab_id;
    let cleanupTab = null;
    try { cleanupTab = await chrome.tabs.get(cleanupTabId); } catch (_) { cleanupTab = null; }
    if ((cleanupTab && cleanupTab.active) || claimedManagedTabs.has(cleanupTabId)) {
      await pauseJob(control, job, "你已打开补全标签页；任务已暂停且不会自动关闭该页。", cleanupTabId);
      return;
    }
    await closeManagedTabUnlessClaimed(cleanupTabId);
    job.cleanup_tab_id = null;
    await persistAndSchedule(control, job);
    return;
  }
  const head = job.queue[0];
  if (!head) {
    job.status = "complete";
    job.inflight = null;
    await persistAndSchedule(control, job);
    return;
  }
  if (job.account_key !== head.membership_key.split("|")[0]
    || !head.membership_key.startsWith(`${job.scope_key}|`)) {
    await pauseJob(control, job, "补全队列的账号或栏目边界无效，请重新选择当前账号栏目");
    return;
  }

  if (!job.inflight) {
    let member;
    let note;
    try {
      [member, note] = await Promise.all([
        getRecord("memberships", head.membership_key),
        getRecord("notes", head.note_id)
      ]);
    } catch (error) {
      await transientEnrichmentFailure(control, job, error && error.message, null);
      return;
    }
    if (!member || member.scope_key !== job.scope_key || member.account_key !== job.account_key || member.account_verified !== true) {
      await terminalQueueEntry(control, job, "skipped", "栏目记录已删除或不再属于当前已核验账号");
      return;
    }
    if (note && note.description) {
      await terminalQueueEntry(control, job, "completed", "");
      return;
    }
    const url = lib.noteUrl(head.note_id, member.xsec_token);
    let parsed;
    try { parsed = new URL(url); } catch (_) { parsed = null; }
    if (!parsed || parsed.origin !== EXACT_ORIGIN || parsed.pathname !== `/explore/${head.note_id}`) {
      await pauseJob(control, job, "拒绝打开无效详情地址");
      return;
    }
    head.attempts += 1;
    job.inflight = {
      lease_id: crypto.randomUUID(),
      note_id: head.note_id,
      membership_key: head.membership_key,
      phase: "opening",
      tab_id: null,
      attempt: head.attempts,
      lease_started_at: Date.now(),
      lease_expires_at: Date.now() + ENRICH_LEASE_MS
    };
    await persistEnrichment(control, job);
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      if (!tab || !Number.isInteger(tab.id)) throw new Error("无法创建详情页标签");
      job.inflight.phase = "loading";
      job.inflight.tab_id = tab.id;
      job.inflight.lease_expires_at = Date.now() + ENRICH_LEASE_MS;
      await persistAndSchedule(control, job);
    } catch (error) {
      await transientEnrichmentFailure(control, job, error && error.message, null);
    }
    return;
  }

  const inflight = job.inflight;
  if (inflight.note_id !== head.note_id || inflight.membership_key !== head.membership_key) {
    await pauseJob(control, job, "补全任务的持久化租约与队列不一致");
    return;
  }
  if (!Number.isInteger(inflight.tab_id)) {
    await transientEnrichmentFailure(control, job, "服务重启时详情页尚未完成创建，将按上限重试", null);
    return;
  }
  let tab;
  try {
    tab = await chrome.tabs.get(inflight.tab_id);
  } catch (_) {
    await transientEnrichmentFailure(control, job, "托管详情页已关闭，将按上限重试", inflight.tab_id);
    return;
  }
  if (tab.active || claimedManagedTabs.has(inflight.tab_id)) {
    await pauseJob(control, job, "你已打开补全标签页；任务已暂停且不会自动关闭该页。", inflight.tab_id);
    return;
  }
  const effectiveUrl = effectiveManagedTabUrl(null, tab);
  if (effectiveUrl && !lib.isExactDetailUrl(effectiveUrl, head.note_id)) {
    await pauseJob(control, job, "详情页发生登录跳转、站外跳转或笔记地址不匹配，任务已暂停。", inflight.tab_id);
    return;
  }
  if (!effectiveUrl || tab.status !== "complete") {
    if (Date.now() >= inflight.lease_expires_at) {
      await transientEnrichmentFailure(control, job, "详情页加载超时，将按上限重试", inflight.tab_id);
    } else {
      await scheduleEnrichmentAlarm();
    }
    return;
  }

  inflight.phase = "extracting";
  inflight.lease_expires_at = Date.now() + ENRICH_LEASE_MS;
  await persistEnrichment(control, job);
  let response;
  try {
    response = await sendToTab(inflight.tab_id, {
      type: "EXTRACT_DETAIL",
      expectedNoteId: head.note_id,
      expectedAccountKey: job.account_key
    });
  } catch (error) {
    await transientEnrichmentFailure(control, job, error && error.message, inflight.tab_id);
    return;
  }
  if (response && response.riskControl) {
    await pauseJob(control, job, "检测到安全验证或访问频繁，补全已立即暂停。", inflight.tab_id);
    return;
  }
  if (response && response.identityMismatch) {
    await pauseJob(control, job, cleanText(response.error, 500) || "当前登录账号与补全账号不一致，任务已暂停。", inflight.tab_id);
    return;
  }
  if (!response || !response.ok) {
    await transientEnrichmentFailure(control, job, cleanText(response && response.error, 500) || "未提取到详情", inflight.tab_id);
    return;
  }
  if (!response.item || response.item.note_id !== head.note_id || response.account_self_id !== job.account_key.slice(4)) {
    await pauseJob(control, job, "详情页返回的笔记或登录账号与任务不匹配，补全已暂停。", inflight.tab_id);
    return;
  }
  let member;
  try {
    member = await getRecord("memberships", head.membership_key);
  } catch (error) {
    await transientEnrichmentFailure(control, job, error && error.message, inflight.tab_id);
    return;
  }
  if (!member || member.scope_key !== job.scope_key || member.account_key !== job.account_key || member.account_verified !== true) {
    await pauseJob(control, job, "详情提交前账号栏目边界发生变化，补全已暂停。", inflight.tab_id);
    return;
  }
  const account = {
    account_key: member.account_key,
    user_id: member.account_key.slice(4),
    profile_id: member.account_key.slice(4),
    label: member.account_label,
    verified: true
  };
  try {
    await enqueue("notes", () => upsertItemsInternal(
      [response.item],
      account,
      member.mode,
      "detail_dom",
      new Date().toISOString()
    ));
  } catch (error) {
    await transientEnrichmentFailure(control, job, error && error.message, inflight.tab_id);
    return;
  }
  job.queue.shift();
  job.completed += 1;
  job.inflight = null;
  job.cleanup_tab_id = inflight.tab_id;
  let userClaimed = claimedManagedTabs.has(inflight.tab_id);
  try {
    const latestTab = await chrome.tabs.get(inflight.tab_id);
    userClaimed = userClaimed || latestTab.active;
  } catch (_) {
    userClaimed = false;
  }
  if (userClaimed) {
    await pauseJob(control, job, "你已打开补全标签页；正文已保存，后续任务已暂停且不会关闭该页。", inflight.tab_id);
    return;
  }
  await persistAndSchedule(control, job);
  if (await closeManagedTabUnlessClaimed(inflight.tab_id)) {
    job.cleanup_tab_id = null;
    await persistAndSchedule(control, job);
  }
}

async function recoverEnrichmentScheduler() {
  const control = await getControl();
  const job = normalizeEnrichmentJob(control.enrichment);
  if (job.status === "running") {
    await persistEnrichment(control, job);
    await scheduleEnrichmentAlarm();
  } else {
    await chrome.alarms.clear(ENRICH_ALARM);
  }
}

async function handleManagedTabActivated(tabId) {
  const control = await getControl();
  const job = normalizeEnrichmentJob(control.enrichment);
  if (job.status !== "running" || !job.inflight || job.inflight.tab_id !== tabId) return;
  await pauseJob(control, job, "你已打开补全标签页；任务已暂停且不会自动关闭该页。", tabId);
}

async function handleManagedTabUpdated(tabId, changeInfo, tab) {
  const control = await getControl();
  const job = normalizeEnrichmentJob(control.enrichment);
  if (job.status !== "running" || !job.inflight || job.inflight.tab_id !== tabId) return;
  if (tab.active || claimedManagedTabs.has(tabId)) {
    await pauseJob(control, job, "你已打开补全标签页；任务已暂停且不会自动关闭该页。", tabId);
    return;
  }
  const effectiveUrl = effectiveManagedTabUrl(changeInfo, tab);
  if (effectiveUrl && !lib.isExactDetailUrl(effectiveUrl, job.inflight.note_id)) {
    await pauseJob(control, job, "详情页发生登录跳转、站外跳转或笔记地址不匹配，任务已暂停。", tabId);
  }
}

async function handleTabRemoved(tabId) {
  claimedManagedTabs.delete(tabId);
  const control = await getControl();
  const job = normalizeEnrichmentJob(control.enrichment);
  if (job.status === "running" && job.inflight && job.inflight.tab_id === tabId) {
    await transientEnrichmentFailure(control, job, "托管详情页已关闭，将按上限重试", tabId);
  } else if (job.retained_tab_id === tabId) {
    delete job.retained_tab_id;
    await persistEnrichment(control, job);
  }

  const run = control.active_runs[String(tabId)];
  if (!run) return;
  run.status = "finished";
  run.complete = false;
  run.completeness = "partial";
  run.stop_reason = "tab_closed";
  run.finished_at = new Date().toISOString();
  delete control.active_runs[String(tabId)];
  await setControl(control);
  await putRecord("runs", run);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  let task;
  if (message.type === "START_RUN") task = enqueue("capture", () => startRun(message, sender));
  else if (message.type === "RECORD_LIST_PAGE") task = enqueue("capture", () => recordListPage(message, sender));
  else if (message.type === "UPSERT_ITEMS") task = enqueue("capture", () => handleUpsert(message, sender));
  else if (message.type === "UPDATE_RUN") task = enqueue("capture", () => updateRun(message, sender));
  else if (message.type === "FINISH_RUN") task = enqueue("capture", () => finishRun(message, sender));
  else if (message.type === "GET_SUMMARY" && popupSender(sender)) task = noteMutationQueue.then(() => summary());
  else if (message.type === "BUILD_EXPORT" && popupSender(sender)) {
    task = enqueue("capture", () => noteMutationQueue
      .then(() => buildExport(message.privateMode === true))
      .then((payload) => ({ ok: true, payload })));
  }
  else if (message.type === "DELETE_SCOPE" && popupSender(sender)) {
    task = enqueue("capture", () => enqueue("notes", () => deleteScope(message.scopeKey)));
  } else if (message.type === "PURGE_TOKENS" && popupSender(sender)) {
    task = enqueue("capture", () => enqueue("notes", () => purgeTokens(message.scopeKey)));
  }
  else if (message.type === "START_ENRICHMENT" && popupSender(sender)) {
    task = enqueue("capture", () => noteMutationQueue.then(() => startEnrichment(
      cleanText(message.scopeKey, 300),
      cleanText(message.currentAccountKey, 180)
    )));
  } else if (message.type === "PAUSE_ENRICHMENT" && popupSender(sender)) {
    task = enqueue("capture", () => pauseEnrichment("用户暂停"));
  }
  else return false;

  Promise.resolve(task).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: cleanText(error && error.message ? error.message : error, 500) });
  });
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ENRICH_ALARM) enqueue("capture", runEnrichmentTick).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue("capture", () => handleTabRemoved(tabId)).catch(() => {});
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  claimedManagedTabs.add(activeInfo.tabId);
  enqueue("capture", () => handleManagedTabActivated(activeInfo.tabId)).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  enqueue("capture", () => handleManagedTabUpdated(tabId, changeInfo, tab)).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  restrictStorageAccess().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  restrictStorageAccess().catch(() => {});
  enqueue("capture", recoverEnrichmentScheduler).catch(() => {});
});

restrictStorageAccess().catch(() => {});
enqueue("capture", recoverEnrichmentScheduler).catch(() => {});
