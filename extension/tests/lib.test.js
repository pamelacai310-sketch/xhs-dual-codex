"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("../src/lib.js");

const NOTE_A = "64a123456789abcdeffedcba";
const NOTE_B = "65b123456789abcdeffedcbb";

test("extracts and normalizes liked API records", () => {
  const payload = {
    data: {
      notes: [
        {
          id: NOTE_A,
          xsec_token: "secret-like-token",
          note_card: {
            display_title: "一条点赞笔记",
            type: "normal",
            user: { user_id: "author-a", nickname: "作者甲" },
            cover: { url_default: "https://sns-webpic-qc.xhscdn.com/a.jpg" },
            interact_info: { liked_count: "1.2万" }
          }
        }
      ],
      has_more: false,
      cursor: "cursor-2"
    }
  };
  const items = lib.extractItemsFromPayload(payload, { mode: "liked", source: "fetch" });
  assert.equal(items.length, 1);
  assert.equal(items[0].note_id, NOTE_A);
  assert.equal(items[0].title, "一条点赞笔记");
  assert.equal(items[0].author.name, "作者甲");
  assert.equal(items[0].liked_count, 12000);
  assert.equal(items[0].xsec_token, "secret-like-token");
  assert.deepEqual(items[0].modes, ["liked"]);
  assert.deepEqual(lib.extractPageInfo(payload), { has_more: false, cursor: "cursor-2" });
});

test("merges duplicate collect records and keeps richer detail", () => {
  const payload = {
    data: {
      items: [
        { note_id: NOTE_B, title: "短标题", xsecToken: "collect-token" },
        {
          noteId: NOTE_B,
          noteCard: {
            displayTitle: "更完整的收藏标题",
            description: "正文内容",
            userInfo: { userId: "author-b", nickname: "作者乙" }
          }
        }
      ],
      hasMore: true,
      nextCursor: "next"
    }
  };
  const items = lib.extractItemsFromPayload(payload, { mode: "collected", source: "xhr" });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "更完整的收藏标题");
  assert.equal(items[0].description, "正文内容");
  assert.equal(items[0].xsec_token, "collect-token");
  assert.deepEqual(items[0].sources, ["xhr"]);
});

test("does not mistake a plain user record for a note", () => {
  const payload = { data: { user: { id: "user1234567890", nickname: "不是笔记" } } };
  assert.deepEqual(lib.extractItemsFromPayload(payload, { mode: "liked", source: "fetch" }), []);
});

test("detects liked and collected modes from URL or visible tab text", () => {
  assert.equal(lib.detectMode("https://www.xiaohongshu.com/user/profile/abc?tab=liked", ""), "liked");
  assert.equal(lib.detectMode("https://www.xiaohongshu.com/user/profile/abc?tab=collect", ""), "collected");
  assert.equal(lib.detectMode("https://www.xiaohongshu.com/user/profile/abc?tab=fav", ""), "collected");
  assert.equal(lib.detectMode("https://www.xiaohongshu.com/user/profile/abc", "收藏"), "collected");
  assert.equal(lib.detectMode("https://www.xiaohongshu.com/explore", "发现"), "unknown");
});

test("allows only supported capture endpoints", () => {
  assert.equal(lib.endpointAllowed("/api/sns/web/v1/note/like/page?num=30"), true);
  assert.equal(lib.endpointAllowed("/api/sns/web/v2/note/collect/page"), true);
  assert.equal(lib.endpointAllowed("/api/sns/web/v1/feed"), true);
  assert.equal(lib.endpointAllowed("/api/sns/web/v1/user/me"), true);
  assert.equal(lib.endpointAllowed("/api/sns/web/v2/user/selfinfo"), true);
  assert.equal(lib.endpointAllowed("initial-state"), true);
  assert.equal(lib.endpointAllowed("/api/sns/web/v1/user/profile"), false);
  assert.equal(lib.endpointAllowed("https://evil.example/api/sns/web/v1/note/like/page"), false);
});

test("deduplicates replayed capture records for the document lifetime", () => {
  const seen = new Set();
  const order = [];
  const firstPage = "550e8400-e29b-41d4-a716-446655440000";
  const secondPage = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const laterPage = "16fd2706-8baf-433b-82eb-8c7fada847da";

  assert.equal(lib.acceptCaptureId(firstPage, seen, order, 2), true);
  assert.equal(lib.acceptCaptureId(secondPage, seen, order, 2), true);
  assert.equal(lib.acceptCaptureId(firstPage, seen, order, 2), false);
  assert.equal(lib.acceptCaptureId("not-a-capture-id", seen, order, 2), false);
  assert.equal(lib.acceptCaptureId(laterPage, seen, order, 2), true);
  assert.equal(seen.has(firstPage), false);
  assert.equal(lib.acceptCaptureId(secondPage, seen, order, 2), false);
});

test("uses the effective managed-tab navigation URL without treating about:blank as a redirect", () => {
  const exact = `https://www.xiaohongshu.com/explore/${NOTE_A}?xsec_token=test`;
  const initialChange = { url: exact };
  const initialTab = { pendingUrl: "", url: "about:blank", status: "loading" };
  const effective = lib.firstHttpUrl(initialChange.url, initialTab.pendingUrl, initialTab.url);

  assert.equal(effective, exact);
  assert.equal(lib.isExactDetailUrl(effective, NOTE_A), true);
  assert.equal(lib.firstHttpUrl("about:blank", "", undefined), "");
  assert.equal(lib.isExactDetailUrl(`https://www.xiaohongshu.com/explore/${NOTE_B}`, NOTE_A), false);
  assert.equal(lib.isExactDetailUrl(`https://evil.example/explore/${NOTE_A}`, NOTE_A), false);
});

test("extracts only a bounded self id projection", () => {
  assert.equal(lib.extractSelfId({ data: { user_id: NOTE_A } }), NOTE_A);
  assert.equal(lib.extractSelfId({ data: { user: { userId: NOTE_B } } }), NOTE_B);
  assert.equal(lib.extractSelfId({ data: { id: NOTE_A, nickname: "not explicit self id" } }), "");
});

test("redacts raw, URL-encoded, double-encoded and HTML-entity token values", () => {
  const token = "TOKEN-canary+/==";
  const encoded = encodeURIComponent(token);
  const encodedTwice = encodeURIComponent(encoded);
  const value = {
    raw: `before ${token} after`,
    encoded: `before ${encoded} after`,
    encodedLower: `before ${encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase())} after`,
    encodedTwice: `before ${encodedTwice} after`,
    htmlHex: `before ${token.replace(/=/g, "&#x3D;")} after`,
    htmlDecimal: `before ${token.replace(/=/g, "&#61;")} after`
  };
  const serialized = JSON.stringify(lib.redactKnownSecrets(value, [token]));
  assert.equal(serialized.includes("TOKEN-canary"), false);
  assert.equal(serialized.includes("%252B"), false);
  assert.equal(serialized.includes("&#x3D;"), false);
  assert.equal(serialized.includes("&#61;"), false);
});

test("redacts tokens, credentials and sensitive URL parameters recursively", () => {
  const input = {
    title: "safe",
    xsec_token: "TOKEN_CANARY",
    cookie: "COOKIE_CANARY",
    nested: {
      Authorization: "Bearer SECRET",
      url: `https://www.xiaohongshu.com/explore/${NOTE_A}?xsec_token=TOKEN_CANARY&xsec_source=pc_user&foo=ok`
    }
  };
  const result = lib.redactSecrets(input);
  const serialized = JSON.stringify(result);
  assert.equal(result.title, "safe");
  assert.equal(result.nested.url, `https://www.xiaohongshu.com/explore/${NOTE_A}?foo=ok`);
  assert.equal(serialized.includes("TOKEN_CANARY"), false);
  assert.equal(serialized.includes("COOKIE_CANARY"), false);
  assert.equal(serialized.includes("Bearer SECRET"), false);
});

test("sanitizes credentials in free text, URL userinfo, query values and nested URLs", () => {
  const nested = encodeURIComponent("https://nested-user:nested-pass@nested.example/a?api_key=NESTED_KEY&keep=yes");
  const input = {
    description: [
      "保留这行普通正文",
      "Cookie: COOKIE_TEXT_CANARY",
      "password=PASSWORD_TEXT_CANARY",
      "Authorization: Bearer AUTH_TEXT_CANARY",
      "链接 https://url-user:url-pass@example.test/a?session_id=SESSION_CANARY&foo=ok",
      `嵌套 https://safe.example/redirect?target=${nested}&chapter=2`,
      "编码 xsec_token%3DENCODED_CANARY"
    ].join("\n"),
    author: { name: "api_key=AUTHOR_KEY_CANARY" }
  };
  const result = lib.redactSecrets(input);
  const serialized = JSON.stringify(result);

  for (const secret of [
    "COOKIE_TEXT_CANARY", "PASSWORD_TEXT_CANARY", "AUTH_TEXT_CANARY",
    "url-user", "url-pass", "SESSION_CANARY", "NESTED_KEY",
    "nested-user", "nested-pass", "ENCODED_CANARY", "AUTHOR_KEY_CANARY"
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(serialized.includes("foo=ok"), true);
  assert.equal(serialized.includes("chapter=2"), true);
  assert.doesNotThrow(() => lib.assertSanitizedExport(result));
  assert.throws(() => lib.assertSanitizedExport(input), /去敏导出/);
  assert.throws(
    () => lib.assertSanitizedExport({ description: "https://user:pass@example.test/?session_id=secret" }),
    /去敏导出/
  );
  const largeSafeExport = {
    items: Array.from({ length: 24 }, (_, index) => ({
      note_id: `safe-note-${String(index).padStart(3, "0")}`,
      description: "普通正文".repeat(25000)
    }))
  };
  assert.doesNotThrow(() => lib.assertSanitizedExport(largeSafeExport));
});

test("rejects encoded URL userinfo and cleans multiply encoded nested URLs", () => {
  const credentialUrl = "https://encoded-user:encoded-pass@encoded.example/path?keep=yes";
  const encodedOnce = encodeURIComponent(credentialUrl);
  const encodedTwice = encodeURIComponent(encodedOnce);
  const htmlEncoded = "https&#x3A;//html-user:html-pass&#64;html.example/path?keep=yes";

  for (const description of [encodedOnce, encodedTwice, htmlEncoded]) {
    assert.throws(
      () => lib.assertSanitizedExport({ description }),
      /凭据链接|去敏导出/
    );
  }
  assert.doesNotThrow(() => lib.assertSanitizedExport({
    description: encodeURIComponent("https://safe.example/path?keep=yes")
  }));

  const nestedPercentUrl = "https://nested-user:nested-pass@nested.example/path?keep=yes";
  const outerPercentUrl = "https://outer.example/redirect"
    + `?target=${encodeURIComponent(encodeURIComponent(nestedPercentUrl))}&chapter=2`;
  assert.throws(
    () => lib.assertSanitizedExport({ description: outerPercentUrl }),
    /凭据链接|去敏导出/
  );
  const cleanedPercentUrl = new URL(lib.stripSensitiveUrl(outerPercentUrl));
  assert.equal(cleanedPercentUrl.searchParams.get("chapter"), "2");
  assert.equal(
    cleanedPercentUrl.searchParams.get("target"),
    "https://nested.example/path?keep=yes"
  );

  const outerHtmlUrl = "https://outer.example/redirect"
    + `?target=${encodeURIComponent(htmlEncoded)}&keep=outer`;
  assert.throws(
    () => lib.assertSanitizedExport({ description: outerHtmlUrl }),
    /凭据链接|去敏导出/
  );
  const cleanedHtmlUrl = new URL(lib.stripSensitiveUrl(outerHtmlUrl));
  assert.equal(cleanedHtmlUrl.searchParams.get("keep"), "outer");
  assert.equal(
    cleanedHtmlUrl.searchParams.get("target"),
    "https://html.example/path?keep=yes"
  );

  const cleanedSerialized = JSON.stringify({
    percent: cleanedPercentUrl.href,
    html: cleanedHtmlUrl.href
  });
  for (const secret of [
    "nested-user", "nested-pass", "html-user", "html-pass"
  ]) {
    assert.equal(cleanedSerialized.includes(secret), false, secret);
  }
});

test("cannot bypass decoding with malformed percent escapes or encoded secret names", () => {
  const dirtyFields = {
    "api%255fkey": "DOUBLE_ENCODED_FIELD",
    ["ses\u200bsion%5fid"]: "FORMAT_FIELD",
    "xsec&amp;#x5f;token": "HTML_FIELD",
    safe: "保留"
  };
  const cleanedFields = lib.redactSecrets(dirtyFields);
  assert.deepEqual(cleanedFields, { safe: "保留" });

  const dirtyText = [
    "畸形在前 %ZZ password%3DMALFORMED_NEIGHBOR",
    "畸形在后 api%255fkey%253DDOUBLE_ENCODED_VALUE%QZ",
    "HTML 与零宽 api&#x200b;&#x5f;key&#x3D;HTML_FORMAT_VALUE",
    "其他格式字符 pass\u180Eword=OTHER_FORMAT_VALUE"
  ].join("\n");
  const cleanedText = lib.sanitizeFreeText(dirtyText);
  for (const secret of [
    "MALFORMED_NEIGHBOR", "DOUBLE_ENCODED_VALUE", "HTML_FORMAT_VALUE", "OTHER_FORMAT_VALUE"
  ]) {
    assert.equal(cleanedText.includes(secret), false, secret);
  }

  const dirtyUrl = "https://safe.example/path"
    + "?api%255fkey=DOUBLE_QUERY"
    + "&ses%E2%80%8Bsion%5fid=FORMAT_QUERY"
    + "&xsec%26%23x5f%3Btoken=HTML_QUERY"
    + "&keep=yes";
  const cleanedUrl = lib.stripSensitiveUrl(dirtyUrl);
  assert.equal(cleanedUrl, "https://safe.example/path?keep=yes");
  for (const secret of ["DOUBLE_QUERY", "FORMAT_QUERY", "HTML_QUERY"]) {
    assert.equal(cleanedUrl.includes(secret), false, secret);
  }
});

test("rejects spoofed bridge payloads that exceed byte, depth, node or field limits", () => {
  const valid = { data: { notes: [{ id: NOTE_A, title: "正常" }] } };
  assert.equal(lib.boundedBridgePayload(valid), valid);
  assert.equal(lib.boundedBridgePayload(null), null);
  assert.equal(lib.boundedBridgePayload({ text: "1234" }, { maxStringLength: 3 }), null);
  assert.equal(lib.boundedBridgePayload({ ["k".repeat(10)]: true }, { maxKeyLength: 8 }), null);
  assert.equal(lib.boundedBridgePayload({ list: [1, 2, 3] }, { maxArrayLength: 2 }), null);
  assert.equal(lib.boundedBridgePayload({ a: 1, b: 2 }, { maxObjectKeys: 1 }), null);
  assert.equal(lib.boundedBridgePayload({ text: "四" }, { maxBytes: 8 }), null);
  assert.equal(lib.boundedBridgePayload({ value: Number.POSITIVE_INFINITY }), null);
  assert.equal(lib.boundedBridgePayload({ list: [1, 2, 3] }, { maxNodes: 4 }), null);
  for (const nonPlain of [new Date(), new Map([["a", 1]]), new Set([1]), /secret/i]) {
    assert.equal(lib.boundedBridgePayload(nonPlain), null);
  }
  const nullPrototype = Object.create(null);
  nullPrototype.safe = true;
  assert.equal(lib.boundedBridgePayload(nullPrototype), nullPrototype);

  const utf8Payload = { text: "四" };
  const utf8Bytes = new TextEncoder().encode(JSON.stringify(utf8Payload)).byteLength;
  assert.equal(lib.boundedBridgePayload(utf8Payload, { maxBytes: utf8Bytes }), utf8Payload);
  assert.equal(lib.boundedBridgePayload(utf8Payload, { maxBytes: utf8Bytes - 1 }), null);

  const deep = { value: true };
  let cursor = deep;
  for (let index = 0; index < 5; index += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  let toJsonCalled = false;
  Object.defineProperty(deep, "toJSON", {
    enumerable: false,
    value() {
      toJsonCalled = true;
      throw new Error("不应在边界检查前序列化完整 payload");
    }
  });
  assert.equal(lib.boundedBridgePayload(deep, { maxDepth: 3 }), null);
  assert.equal(toJsonCalled, false);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(lib.boundedBridgePayload(cyclic), null);
});

test("manifest keeps a narrow permission surface", () => {
  const manifestPath = path.join(__dirname, "..", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest.host_permissions, ["https://www.xiaohongshu.com/*"]);
  const forbidden = ["cookies", "webRequest", "debugger", "tabs", "scripting", "<all_urls>"];
  const declared = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
  for (const permission of forbidden) assert.equal(declared.includes(permission), false);
  assert.equal(manifest.content_scripts.some((entry) => entry.world === "MAIN"), true);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(Number(manifest.minimum_chrome_version) >= 120, true);
  assert.equal(manifest.content_security_policy.extension_pages.includes("object-src 'none'"), true);
});
