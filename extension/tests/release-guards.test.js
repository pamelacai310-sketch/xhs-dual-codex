"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = path.join(__dirname, "..");
const source = (relativePath) => fs.readFileSync(path.join(extensionRoot, relativePath), "utf8");

test("enrichment uses a durable single-account lease and bounded retries", () => {
  const background = source("src/background.js");
  assert.match(background, /const ENRICH_MAX_RETRIES = 3/);
  assert.match(background, /inflight:\s*null/);
  assert.match(background, /phase:\s*"opening"/);
  assert.match(background, /phase = "loading"/);
  assert.match(background, /phase = "extracting"/);
  assert.match(background, /currentAccountKey/);
  assert.match(background, /member\.account_verified !== true/);
  assert.match(background, /response\.account_self_id !== job\.account_key\.slice\(4\)/);
  assert.match(background, /job\.cleanup_tab_id = inflight\.tab_id/);
  assert.match(background, /该范围仍被正文补全队列引用/);
  assert.match(background, /该范围仍在正文补全队列中/);
  assert.doesNotMatch(background, /periodInMinutes/);
});

test("pausing closes an unclaimed managed tab without advancing the queue", () => {
  const background = source("src/background.js");
  const pauseStart = background.indexOf("async function pauseEnrichment");
  const pauseEnd = background.indexOf("async function terminalQueueEntry", pauseStart);
  const pauseBody = background.slice(pauseStart, pauseEnd);
  assert.match(pauseBody, /claimedManagedTabs\.has\(managedTabId\)/);
  assert.match(pauseBody, /job\.cleanup_tab_id = managedTabId/);
  assert.match(pauseBody, /closeManagedTabUnlessClaimed\(managedTabId\)/);
  assert.doesNotMatch(pauseBody, /job\.queue\.shift\(\)/);
});

test("managed tab updates prefer navigation and pending URLs over transient tab URLs", () => {
  const background = source("src/background.js");
  assert.match(background, /lib\.firstHttpUrl\(\s*changeInfo && changeInfo\.url,\s*tab && tab\.pendingUrl,\s*tab && tab\.url/s);
  assert.match(background, /handleManagedTabUpdated\(tabId, changeInfo, tab\)/);
  assert.match(background, /effectiveUrl && !lib\.isExactDetailUrl\(effectiveUrl, job\.inflight\.note_id\)/);
  assert.match(background, /handleManagedTabUpdated\(tabId, changeInfo, tab\)\)\.catch/);
});

test("popup requires one selected verified scope and does not overlap polling", () => {
  const popup = source("popup.js");
  const html = source("popup.html");
  assert.match(popup, /currentAccountKey:\s*account\.account_key/);
  assert.match(popup, /refreshInFlight/);
  assert.match(popup, /value\.remaining/);
  assert.doesNotMatch(html, /全部账号与栏目/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /<style\b/i);
});

test("bridge processing drains before finish and identity responses are projected", () => {
  const content = source("src/content.js");
  const injected = source("src/injected.js");
  const background = source("src/background.js");
  assert.match(content, /bridgeProcessingQueue = operation\.catch/);
  assert.match(content, /await bridgeProcessingQueue\.catch/);
  assert.match(content, /if \(stopCapturePromise\) return stopCapturePromise/);
  assert.match(content, /expectedAccountKey/);
  assert.match(content, /data\.httpStatus === 429/);
  assert.match(content, /data\.httpStatus === 401 \|\| data\.httpStatus === 403/);
  assert.match(content, /data\.httpStatus >= 500/);
  assert.match(content, /data\.httpStatus < 200 \|\| data\.httpStatus >= 300/);
  assert.match(content, /rejectListResponse\("risk_control"/);
  assert.match(background, /列表错误响应不能计入分页完整性/);
  assert.match(injected, /return \{ data: \{ user_id: value \} \}/);
  assert.match(injected, /httpStatus/);
});

test("probe and capture replays share stable document-lifetime capture ids", () => {
  const content = source("src/content.js");
  const injected = source("src/injected.js");
  const startCaptureAt = content.indexOf("async function startCapture");
  const stopCaptureAt = content.indexOf("async function finishCapture", startCaptureAt);
  const startCaptureBody = content.slice(startCaptureAt, stopCaptureAt);
  assert.match(injected, /captureId: crypto\.randomUUID\(\)/);
  assert.match(injected, /captureId: record\.captureId/);
  assert.match(content, /const seenCaptureIds = new Set\(\)/);
  assert.match(content, /const captureIdQueue = \[\]/);
  assert.match(content, /lib\.acceptCaptureId\(data\.captureId, seenCaptureIds, captureIdQueue, MAX_CAPTURE_IDS\)/);
  assert.doesNotMatch(startCaptureBody, /seenCaptureIds\s*=|captureIdQueue\s*=/);
});

test("safe exports carry a stable opaque profile namespace", () => {
  const background = source("src/background.js");
  assert.match(background, /const EXPORT_IDENTITY_KEY = "xhs\.export\.identity\.v1"/);
  assert.match(background, /profile_namespace: exportIdentity\.profile_namespace/);
  assert.match(background, /account-\$\{crypto\.randomUUID\(\)\}/);
  assert.match(background, /lib\.redactKnownSecrets/);
  assert.match(background, /lib\.assertSanitizedExport\(sanitized\)/);
  assert.match(background, /字段白名单与已知敏感模式尽力去除/);
  assert.doesNotMatch(background, /仅限本人本机恢复使用/);
});

test("isolated relay bounds untrusted page payloads before caching or processing", () => {
  const content = source("src/content.js");
  const lib = source("src/lib.js");
  const boundAt = content.indexOf("lib.boundedBridgePayload(data.payload)");
  const acceptAt = content.indexOf("lib.acceptCaptureId(data.captureId", boundAt);
  const pendingAt = content.indexOf("pendingBridgeMessages.push(bounded)", boundAt);
  assert.ok(boundAt > 0);
  assert.ok(acceptAt > boundAt);
  assert.ok(pendingAt > boundAt);
  assert.match(content, /data\.endpoint\.length > 2000/);
  assert.match(content, /data\.captureId\.length !== 36/);
  assert.match(content, /data\.transport\.length > 20/);
  assert.match(content, /data\.capturedAt\.length > 100/);
  const helperStart = lib.indexOf("function boundedBridgePayload");
  const helperEnd = lib.indexOf("function percentLowercase", helperStart);
  const helper = lib.slice(helperStart, helperEnd);
  assert.match(helper, /const stack = \[\{ value: payload, depth: 0 \}\]/);
  assert.match(helper, /encoder\.encode\(serialized\)\.byteLength/);
  assert.doesNotMatch(helper, /JSON\.stringify\(payload\)/);
});
