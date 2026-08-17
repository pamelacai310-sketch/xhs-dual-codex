(function initXhsDualLib(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.XHSDualLib = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createXhsDualLib() {
  "use strict";

  const NOTE_ID_RE = /^[0-9a-zA-Z_-]{12,64}$/;
  const ALLOWED_ENDPOINT_RE = /^\/api\/sns\/web\/v\d+\/(?:note\/(?:like|likes|collect|collection|favorite|favorites)(?:\/page)?|note\/detail|feed|user\/(?:me|selfinfo))(?:\/|\?|$)/i;
  const CAPTURE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const COOKIE_HEADER_RE = /\b(?:cookie|set-cookie|authorization)\b\s*:\s*[^\r\n]*/gi;
  const COOKIE_HEADER_TEST_RE = /\b(?:cookie|set-cookie|authorization)\b\s*:\s*[^\r\n]*/i;
  const SECRET_ASSIGNMENT_SOURCE = String.raw`(?:"|')?\b(?:xsec[_-]?token|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|set-cookie|cookie|session(?:[_-]?id)?|api[_-]?key|client[_-]?secret|password|passwd|pwd|x[-_]?amz[-_]?(?:credential|signature|security[-_]?token)|x[-_]?goog[-_]?(?:credential|signature)|signature|credential|policy|key[-_]?pair[-_]?id|auth[-_]?key|aws[-_]?access[-_]?key[-_]?id|google[-_]?access[-_]?id|oss[-_]?access[-_]?key[-_]?id)\b(?:"|')?\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;，；}\]]+)`;
  const SECRET_ASSIGNMENT_RE = new RegExp(SECRET_ASSIGNMENT_SOURCE, "gi");
  const SECRET_ASSIGNMENT_TEST_RE = new RegExp(SECRET_ASSIGNMENT_SOURCE, "i");
  const EMBEDDED_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
  const FORMAT_CHAR_RE = /\p{Cf}/gu;
  const MAX_SECRET_DECODE_ROUNDS = 8;
  const MAX_SECRET_DECODE_CHARS = 2 * 1024 * 1024;
  const SECRET_NORMALIZED_NAMES = new Set([
    "xsectoken", "xsecsource", "accesstoken", "refreshtoken", "authtoken", "token",
    "cookie", "setcookie", "authorization", "session", "sessionid", "sid", "apikey",
    "clientsecret", "secret", "password", "passwd", "pwd", "credential", "sign",
    "signature", "authkey", "expire", "expires", "policy", "keypairid",
    "xamzcredential", "xamzsignature", "xamzsecuritytoken", "xgoogcredential",
    "xgoogsignature", "awsaccesskeyid", "googleaccessid", "ossaccesskeyid"
  ]);
  const SECRET_NORMALIZED_PARTS = [
    "xsectoken", "xsecsource", "accesstoken", "refreshtoken", "authtoken",
    "cookie", "authorization", "session", "apikey", "clientsecret", "secret",
    "password", "passwd", "credential", "signature", "authkey", "keypairid",
    "awsaccesskeyid", "googleaccessid", "ossaccesskeyid"
  ];
  const DEFAULT_BRIDGE_LIMITS = Object.freeze({
    maxBytes: 6 * 1024 * 1024,
    maxDepth: 32,
    maxNodes: 100000,
    maxArrayLength: 10000,
    maxObjectKeys: 10000,
    maxKeyLength: 256,
    maxStringLength: 200000
  });

  function first(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }

  function asText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  }

  function compactText(value, maxLength) {
    const text = asText(value).replace(/\s+/g, " ").trim();
    if (!maxLength || text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  function validNoteId(value) {
    const id = asText(value);
    return NOTE_ID_RE.test(id) ? id : "";
  }

  function acceptCaptureId(value, seenIds, orderedIds, maxEntries) {
    if (typeof value !== "string" || !CAPTURE_ID_RE.test(value)) return false;
    if (!(seenIds instanceof Set) || !Array.isArray(orderedIds)) return false;
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000) return false;
    if (seenIds.has(value)) return false;
    seenIds.add(value);
    orderedIds.push(value);
    while (orderedIds.length > maxEntries) {
      seenIds.delete(orderedIds.shift());
    }
    return true;
  }

  function firstHttpUrl(...values) {
    for (const value of values) {
      if (typeof value !== "string" || !value.trim()) continue;
      try {
        const url = new URL(value);
        if (url.protocol === "http:" || url.protocol === "https:") return url.href;
      } catch (_) {
        // Ignore transient values such as about:blank and malformed navigation URLs.
      }
    }
    return "";
  }

  function isExactDetailUrl(value, noteId) {
    const expectedId = validNoteId(noteId);
    if (!expectedId) return false;
    try {
      const url = new URL(value);
      return url.origin === "https://www.xiaohongshu.com" && url.pathname === `/explore/${expectedId}`;
    } catch (_) {
      return false;
    }
  }

  function getPath(object, path) {
    let current = object;
    for (const key of path) {
      if (!current || typeof current !== "object") return undefined;
      current = current[key];
    }
    return current;
  }

  function pickPath(object, paths) {
    for (const path of paths) {
      const value = getPath(object, path);
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }

  function normalizeCount(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const text = asText(value).replace(/,/g, "");
    if (!text) return null;
    const match = text.match(/^([\d.]+)\s*([万千wk]?)$/i);
    if (!match) return text;
    const number = Number(match[1]);
    if (!Number.isFinite(number)) return text;
    const unit = match[2].toLowerCase();
    if (unit === "万" || unit === "w") return Math.round(number * 10000);
    if (unit === "千" || unit === "k") return Math.round(number * 1000);
    return Math.round(number);
  }

  function normalizeImageUrl(value) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const normalized = normalizeImageUrl(entry);
        if (normalized) return normalized;
      }
      return "";
    }
    if (value && typeof value === "object") {
      return normalizeImageUrl(first(
        value.url_default,
        value.urlDefault,
        value.url,
        value.url_pre,
        value.urlPre,
        value.info_list,
        value.infoList
      ));
    }
    const text = asText(value);
    if (!text) return "";
    try {
      const url = new URL(text, "https://www.xiaohongshu.com");
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch (_) {
      return "";
    }
    return "";
  }

  function decodeHtmlEntities(value) {
    return String(value)
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#x([0-9a-f]{1,6});/gi, (_, digits) => {
        const point = Number.parseInt(digits, 16);
        return Number.isInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      })
      .replace(/&#([0-9]{1,7});/g, (_, digits) => {
        const point = Number.parseInt(digits, 10);
        return Number.isInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : "";
      });
  }

  function securityText(value) {
    return String(value).normalize("NFKC").replace(FORMAT_CHAR_RE, "");
  }

  function decodePercentBestEffort(value) {
    return String(value).replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch (_) {
        const bytes = [];
        run.replace(/%([0-9a-f]{2})/gi, (_, pair) => {
          bytes.push(Number.parseInt(pair, 16));
          return "";
        });
        try {
          return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
        } catch (_) {
          return run.replace(/%([0-9a-f]{2})/gi, (_, pair) => String.fromCharCode(Number.parseInt(pair, 16)));
        }
      }
    });
  }

  function decodedTextVariants(value) {
    let current = securityText(value);
    if (current.length > MAX_SECRET_DECODE_CHARS) return null;
    const variants = [current];
    let total = current.length;
    for (let round = 0; round < MAX_SECRET_DECODE_ROUNDS; round += 1) {
      let decoded = decodePercentBestEffort(decodeHtmlEntities(current));
      decoded = securityText(decoded);
      total += decoded.length;
      if (total > MAX_SECRET_DECODE_CHARS) return null;
      if (decoded === current) break;
      variants.push(decoded);
      current = decoded;
    }
    return variants;
  }

  function normalizedSecretName(value) {
    return securityText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function isSecretName(value) {
    const variants = decodedTextVariants(value);
    if (variants === null) return true;
    return variants.some((candidate) => {
      const normalized = normalizedSecretName(candidate);
      return SECRET_NORMALIZED_NAMES.has(normalized)
        || SECRET_NORMALIZED_PARTS.some((part) => normalized.includes(part))
        || normalized.startsWith("xamz")
        || normalized.startsWith("xgoog");
    });
  }

  function hasCredentialMaterial(value) {
    const variants = decodedTextVariants(value);
    if (variants === null) return true;
    return variants.some((candidate) => COOKIE_HEADER_TEST_RE.test(candidate)
      || SECRET_ASSIGNMENT_TEST_RE.test(candidate));
  }

  function decodedFullHttpUrl(value) {
    const variants = decodedTextVariants(value);
    if (variants === null) return null;
    let nestedUrl = "";
    for (const candidate of variants) {
      const trimmed = candidate.trim();
      if (!/^https?:\/\//i.test(trimmed)) continue;
      try {
        const parsed = new URL(trimmed);
        if (/^https?:$/.test(parsed.protocol)) nestedUrl = trimmed;
      } catch (_) {
        // A later decoding round may still yield a complete URL.
      }
    }
    return nestedUrl;
  }

  function textContainsCredentialUrl(value, depth) {
    if ((depth || 0) > MAX_SECRET_DECODE_ROUNDS) return true;
    const variants = decodedTextVariants(value);
    if (variants === null) return true;
    for (const candidate of variants) {
      for (const match of candidate.matchAll(new RegExp(EMBEDDED_URL_RE.source, "gi"))) {
        if (urlContainsCredential(match[0], depth || 0)) return true;
      }
    }
    return false;
  }

  function urlContainsCredential(value, depth) {
    if ((depth || 0) > MAX_SECRET_DECODE_ROUNDS) return true;
    let url;
    try {
      url = new URL(decodeHtmlEntities(asText(value)));
    } catch (_) {
      return true;
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return true;
    const params = new URLSearchParams(url.search.slice(1).replace(/;/g, "&"));
    for (const [key, itemValue] of params.entries()) {
      if (isSecretName(key) || hasCredentialMaterial(itemValue)) return true;
      if (textContainsCredentialUrl(itemValue, (depth || 0) + 1)) return true;
    }
    return false;
  }

  function stripSensitiveUrl(value, depth) {
    const text = asText(value);
    if (!text) return "";
    if ((depth || 0) > MAX_SECRET_DECODE_ROUNDS) return "";
    try {
      const url = new URL(decodeHtmlEntities(text), "https://www.xiaohongshu.com");
      if (!/^https?:$/.test(url.protocol)) return "";
      url.username = "";
      url.password = "";
      const params = new URLSearchParams(url.search.slice(1).replace(/;/g, "&"));
      url.search = "";
      for (const [key, rawItemValue] of params.entries()) {
        if (isSecretName(key) || hasCredentialMaterial(rawItemValue)) continue;
        let itemValue = rawItemValue;
        const decodedNested = decodedFullHttpUrl(itemValue);
        if (decodedNested === null) continue;
        if (decodedNested) {
          itemValue = stripSensitiveUrl(decodedNested, (depth || 0) + 1);
          if (!itemValue) continue;
        } else if (textContainsCredentialUrl(itemValue, (depth || 0) + 1)) {
          continue;
        }
        url.searchParams.append(key, itemValue);
      }
      url.hash = "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function sanitizeFreeText(value) {
    const text = securityText(value);
    if (text.length > MAX_SECRET_DECODE_CHARS) return "[超长文本已移除]";
    let output = text.replace(EMBEDDED_URL_RE, (matched) => {
      let raw = matched;
      let trailing = "";
      while (raw && /[.,;!?\])}，。；！？]/.test(raw.slice(-1))) {
        trailing = raw.slice(-1) + trailing;
        raw = raw.slice(0, -1);
      }
      const cleaned = stripSensitiveUrl(raw);
      return `${cleaned || "[无效链接已移除]"}${trailing}`;
    });
    output = output.replace(COOKIE_HEADER_RE, "[敏感信息已移除]");
    output = output.replace(SECRET_ASSIGNMENT_RE, "[敏感信息已移除]");
    output = output.split("\n").map((line) => {
      const unsafe = hasCredentialMaterial(line) || textContainsCredentialUrl(line, 0);
      return unsafe ? "[含编码敏感信息的整行已移除]" : line;
    }).join("\n");
    return output;
  }

  function noteUrl(noteId, token) {
    const id = validNoteId(noteId);
    if (!id) return "";
    const url = new URL(`/explore/${encodeURIComponent(id)}`, "https://www.xiaohongshu.com");
    const xsecToken = asText(token);
    if (xsecToken) {
      url.searchParams.set("xsec_token", xsecToken);
      url.searchParams.set("xsec_source", "pc_user");
    }
    return url.href;
  }

  function flattenCandidate(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const nested = first(raw.note_card, raw.noteCard, raw.note, raw.item, raw.note_info, raw.noteInfo);
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return raw;
    return Object.assign({}, raw, nested, {
      __outer: raw,
      __inner: nested
    });
  }

  function looksLikeNote(raw) {
    const candidate = flattenCandidate(raw);
    if (!candidate) return false;
    const explicitId = first(
      candidate.note_id,
      candidate.noteId,
      candidate.note_id_str,
      getPath(candidate, ["__outer", "note_id"]),
      getPath(candidate, ["__outer", "noteId"])
    );
    const genericId = first(candidate.id, getPath(candidate, ["__outer", "id"]));
    const noteId = validNoteId(first(explicitId, genericId));
    if (!noteId) return false;
    if (explicitId) return true;
    const evidence = [
      "display_title", "displayTitle", "title", "desc", "description", "type",
      "cover", "image_list", "imageList", "interact_info", "interactInfo",
      "user", "user_info", "userInfo", "xsec_token", "xsecToken"
    ];
    return evidence.some((key) => candidate[key] !== undefined);
  }

  function normalizeAuthor(candidate) {
    const user = first(
      candidate.user,
      candidate.user_info,
      candidate.userInfo,
      getPath(candidate, ["__outer", "user"]),
      getPath(candidate, ["__outer", "user_info"]),
      {}
    );
    return {
      id: compactText(first(user.user_id, user.userId, user.id, candidate.user_id, candidate.userId), 80),
      name: compactText(first(user.nickname, user.nick_name, user.name, candidate.nickname, candidate.author_name), 200)
    };
  }

  function normalizeTags(candidate) {
    const rawTags = first(candidate.tag_list, candidate.tagList, candidate.tags, candidate.topics, []);
    if (!Array.isArray(rawTags)) return [];
    const values = rawTags.map((tag) => {
      if (typeof tag === "string") return compactText(tag, 100);
      if (tag && typeof tag === "object") {
        return compactText(first(tag.name, tag.title, tag.tag_name, tag.tagName), 100);
      }
      return "";
    }).filter(Boolean);
    return Array.from(new Set(values)).slice(0, 100);
  }

  function normalizeItem(raw, context) {
    const candidate = flattenCandidate(raw);
    if (!candidate || !looksLikeNote(raw)) return null;
    const outer = candidate.__outer || raw;
    const noteId = validNoteId(first(
      candidate.note_id,
      candidate.noteId,
      candidate.note_id_str,
      outer.note_id,
      outer.noteId,
      candidate.id,
      outer.id
    ));
    if (!noteId) return null;

    const xsecToken = compactText(first(
      outer.xsec_token,
      outer.xsecToken,
      candidate.xsec_token,
      candidate.xsecToken
    ), 2048);
    const explicitUrl = asText(first(
      outer.url,
      outer.web_url,
      outer.webUrl,
      candidate.url,
      candidate.web_url,
      candidate.webUrl
    ));
    const contextMode = context && context.mode ? asText(context.mode) : "unknown";
    const source = context && context.source ? asText(context.source) : "api";
    const capturedAt = context && context.capturedAt
      ? asText(context.capturedAt)
      : new Date().toISOString();

    const cover = normalizeImageUrl(first(
      candidate.cover,
      candidate.cover_url,
      candidate.coverUrl,
      candidate.image_list,
      candidate.imageList,
      getPath(candidate, ["__inner", "cover"])
    ));
    const title = compactText(first(
      candidate.display_title,
      candidate.displayTitle,
      candidate.title,
      outer.display_title,
      outer.displayTitle,
      outer.title
    ), 1000);
    const description = compactText(first(
      candidate.desc,
      candidate.description,
      candidate.content,
      outer.desc,
      outer.description
    ), 100000);
    const type = compactText(first(candidate.type, candidate.note_type, candidate.noteType, outer.type), 100);
    const likedCount = normalizeCount(first(
      pickPath(candidate, [
        ["interact_info", "liked_count"],
        ["interactInfo", "likedCount"],
        ["interact_info", "likedCount"],
        ["interactInfo", "liked_count"]
      ]),
      candidate.liked_count,
      candidate.likedCount,
      outer.liked_count,
      outer.likedCount
    ));
    const rawUrl = explicitUrl || noteUrl(noteId, xsecToken);

    return {
      note_id: noteId,
      title,
      description,
      author: normalizeAuthor(candidate),
      note_type: type,
      cover_url: cover,
      liked_count: likedCount,
      tags: normalizeTags(candidate),
      xsec_token: xsecToken,
      url: rawUrl,
      safe_url: stripSensitiveUrl(rawUrl || noteUrl(noteId, "")),
      modes: contextMode && contextMode !== "unknown" ? [contextMode] : [],
      sources: source ? [source] : [],
      captured_at: capturedAt
    };
  }

  function extractItemsFromPayload(payload, context) {
    const itemsById = new Map();
    const seen = new Set();
    const stack = [{ value: payload, depth: 0 }];
    const maxDepth = context && Number.isFinite(context.maxDepth) ? context.maxDepth : 14;
    const maxNodes = context && Number.isFinite(context.maxNodes) ? context.maxNodes : 50000;
    let visited = 0;

    while (stack.length && visited < maxNodes) {
      const entry = stack.pop();
      const value = entry.value;
      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited += 1;

      if (!Array.isArray(value) && looksLikeNote(value)) {
        const item = normalizeItem(value, context || {});
        if (item) {
          const previous = itemsById.get(item.note_id);
          itemsById.set(item.note_id, previous ? mergeItems(previous, item) : item);
        }
      }
      if (entry.depth >= maxDepth) continue;
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i -= 1) {
          stack.push({ value: value[i], depth: entry.depth + 1 });
        }
      } else {
        for (const [key, child] of Object.entries(value)) {
          if (key.startsWith("__")) continue;
          if (child && typeof child === "object") {
            stack.push({ value: child, depth: entry.depth + 1 });
          }
        }
      }
    }
    return Array.from(itemsById.values());
  }

  function extractListItems(payload, context) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const containers = [];
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      containers.push(payload.data);
      if (payload.data.data && typeof payload.data.data === "object" && !Array.isArray(payload.data.data)) {
        containers.push(payload.data.data);
      }
    }
    containers.push(payload);
    let records = null;
    for (const container of containers) {
      for (const key of ["notes", "items", "list"]) {
        if (Array.isArray(container[key])) {
          records = container[key];
          break;
        }
      }
      if (records) break;
    }
    if (!records) return [];
    const itemsById = new Map();
    for (const record of records.slice(0, 5000)) {
      const item = normalizeItem(record, context || {});
      if (!item) continue;
      itemsById.set(item.note_id, itemsById.has(item.note_id)
        ? mergeItems(itemsById.get(item.note_id), item)
        : item);
    }
    return Array.from(itemsById.values());
  }

  function findFirstKey(payload, keys, maxNodes) {
    const wanted = new Set(keys);
    const stack = [payload];
    const seen = new Set();
    let count = 0;
    while (stack.length && count < (maxNodes || 10000)) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      count += 1;
      if (!Array.isArray(value)) {
        for (const [key, child] of Object.entries(value)) {
          if (wanted.has(key)) return child;
          if (child && typeof child === "object") stack.push(child);
        }
      } else {
        for (const child of value) {
          if (child && typeof child === "object") stack.push(child);
        }
      }
    }
    return undefined;
  }

  function extractPageInfo(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { has_more: null, cursor: "" };
    }
    const containers = [];
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      containers.push(payload.data);
      if (payload.data.data && typeof payload.data.data === "object" && !Array.isArray(payload.data.data)) {
        containers.push(payload.data.data);
      }
    }
    containers.push(payload);
    let container = null;
    for (const candidate of containers) {
      if (Object.prototype.hasOwnProperty.call(candidate, "has_more")
        || Object.prototype.hasOwnProperty.call(candidate, "hasMore")) {
        container = candidate;
        break;
      }
    }
    if (!container) return { has_more: null, cursor: "" };
    const hasMoreValue = first(container.has_more, container.hasMore);
    const cursorValue = first(container.cursor, container.next_cursor, container.nextCursor);
    let hasMore = null;
    if (typeof hasMoreValue === "boolean") hasMore = hasMoreValue;
    else if (hasMoreValue === 0 || hasMoreValue === "0" || hasMoreValue === "false") hasMore = false;
    else if (hasMoreValue === 1 || hasMoreValue === "1" || hasMoreValue === "true") hasMore = true;
    return {
      has_more: hasMore,
      cursor: compactText(cursorValue, 2048)
    };
  }

  function extractSelfId(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    const candidates = [
      payload.data,
      payload.user,
      payload.current_user,
      payload.currentUser,
      getPath(payload, ["data", "user"]),
      getPath(payload, ["data", "user_info"]),
      getPath(payload, ["data", "userInfo"]),
      getPath(payload, ["user", "currentUser"]),
      getPath(payload, ["user", "userInfo"]),
      getPath(payload, ["user", "loggedInUser"])
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const value = validNoteId(first(candidate.user_id, candidate.userId));
      if (value) return value;
    }
    return "";
  }

  function mergeArrays(left, right, maxLength) {
    return Array.from(new Set([...(left || []), ...(right || [])].filter(Boolean))).slice(0, maxLength || 1000);
  }

  function preferRicher(left, right) {
    const a = asText(left);
    const b = asText(right);
    return b.length > a.length ? right : left;
  }

  function mergeItems(left, right) {
    if (!left) return right;
    if (!right) return left;
    const merged = Object.assign({}, left, right);
    merged.note_id = left.note_id || right.note_id;
    merged.title = preferRicher(left.title, right.title);
    merged.description = preferRicher(left.description, right.description);
    merged.note_type = preferRicher(left.note_type, right.note_type);
    merged.cover_url = preferRicher(left.cover_url, right.cover_url);
    merged.xsec_token = preferRicher(left.xsec_token, right.xsec_token);
    merged.url = merged.xsec_token
      ? preferRicher(left.url, right.url) || noteUrl(merged.note_id, merged.xsec_token)
      : preferRicher(left.url, right.url);
    merged.safe_url = stripSensitiveUrl(preferRicher(left.safe_url, right.safe_url) || merged.url || noteUrl(merged.note_id, ""));
    merged.author = {
      id: preferRicher(left.author && left.author.id, right.author && right.author.id),
      name: preferRicher(left.author && left.author.name, right.author && right.author.name)
    };
    merged.liked_count = right.liked_count !== null && right.liked_count !== undefined
      ? right.liked_count
      : left.liked_count;
    merged.tags = mergeArrays(left.tags, right.tags, 100);
    merged.modes = mergeArrays(left.modes, right.modes, 10);
    merged.sources = mergeArrays(left.sources, right.sources, 20);
    merged.captured_at = [left.captured_at, right.captured_at].filter(Boolean).sort().pop() || new Date().toISOString();
    return merged;
  }

  function detectMode(urlValue, activeText) {
    const text = `${asText(urlValue)} ${asText(activeText)}`.toLowerCase();
    let tab = "";
    try {
      tab = new URL(asText(urlValue), "https://www.xiaohongshu.com").searchParams.get("tab") || "";
      tab = tab.toLowerCase();
    } catch (_) {
      tab = "";
    }
    if (["liked", "like", "likes"].includes(tab) || /(?:^|\s)(赞过|点赞|liked|likes)(?:\s|$)/i.test(text)) return "liked";
    if (["collect", "collected", "collection", "collections", "favorite", "favorites", "fav"].includes(tab)
      || /收藏|collect|favorite/i.test(text)) return "collected";
    return "unknown";
  }

  function modeFromEndpoint(endpoint, fallback) {
    const text = asText(endpoint).toLowerCase();
    if (/\/(?:like|likes)(?:\/|\?|$)/.test(text)) return "liked";
    if (/\/(?:collect|collection|favorite|favorites)(?:\/|\?|$)/.test(text)) return "collected";
    return fallback || "unknown";
  }

  function endpointAllowed(endpoint) {
    const value = asText(endpoint);
    if (value === "initial-state") return true;
    if (!value.startsWith("/api/")) return false;
    return ALLOWED_ENDPOINT_RE.test(value);
  }

  function redactSecrets(value, options, seen) {
    const settings = options || {};
    const visited = seen || new WeakSet();
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      return sanitizeFreeText(value);
    }
    if (typeof value !== "object") return value;
    if (visited.has(value)) return "[circular]";
    visited.add(value);
    if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, settings, visited));
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSecretName(key)) continue;
      output[key] = redactSecrets(child, settings, visited);
    }
    return output;
  }

  function assertSanitizedExport(value) {
    const visited = new WeakSet();
    const stack = [value];
    while (stack.length) {
      const current = stack.pop();
      if (current === null || current === undefined) continue;
      if (typeof current === "string") {
        if (hasCredentialMaterial(current)) throw new Error("去敏导出仍含凭据赋值或请求头");
        if (textContainsCredentialUrl(current, 0)) throw new Error("去敏导出仍含凭据链接");
        continue;
      }
      if (typeof current !== "object") continue;
      if (visited.has(current)) throw new Error("去敏导出含循环对象");
      visited.add(current);
      if (Array.isArray(current)) {
        for (const child of current) stack.push(child);
        continue;
      }
      for (const [key, child] of Object.entries(current)) {
        if (isSecretName(key)) throw new Error("去敏导出仍含敏感字段");
        stack.push(child);
      }
    }

    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch (_) {
      throw new Error("去敏导出无法安全序列化");
    }
    if (typeof serialized !== "string"
      || COOKIE_HEADER_TEST_RE.test(serialized)
      || SECRET_ASSIGNMENT_TEST_RE.test(serialized)) {
      throw new Error("序列化后的去敏导出未通过凭据审计");
    }
    for (const match of serialized.matchAll(new RegExp(EMBEDDED_URL_RE.source, "gi"))) {
      if (urlContainsCredential(match[0], 0)) throw new Error("序列化后的去敏导出未通过链接审计");
    }
    return value;
  }

  function positiveLimit(value, fallback) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  function boundedBridgePayload(payload, options) {
    const settings = options || {};
    const limits = {
      maxBytes: positiveLimit(settings.maxBytes, DEFAULT_BRIDGE_LIMITS.maxBytes),
      maxDepth: positiveLimit(settings.maxDepth, DEFAULT_BRIDGE_LIMITS.maxDepth),
      maxNodes: positiveLimit(settings.maxNodes, DEFAULT_BRIDGE_LIMITS.maxNodes),
      maxArrayLength: positiveLimit(settings.maxArrayLength, DEFAULT_BRIDGE_LIMITS.maxArrayLength),
      maxObjectKeys: positiveLimit(settings.maxObjectKeys, DEFAULT_BRIDGE_LIMITS.maxObjectKeys),
      maxKeyLength: positiveLimit(settings.maxKeyLength, DEFAULT_BRIDGE_LIMITS.maxKeyLength),
      maxStringLength: positiveLimit(settings.maxStringLength, DEFAULT_BRIDGE_LIMITS.maxStringLength)
    };
    if (!payload || typeof payload !== "object") return null;
    const encoder = new TextEncoder();
    const visited = new WeakSet();
    const stack = [{ value: payload, depth: 0 }];
    let nodes = 0;
    let bytes = 0;
    const addBytes = (amount) => {
      bytes += amount;
      return bytes <= limits.maxBytes;
    };
    const addJsonPrimitive = (value) => {
      let serialized;
      try {
        // This serializes only one already-bounded string/key or finite number,
        // never the full untrusted payload.
        serialized = JSON.stringify(value);
      } catch (_) {
        return false;
      }
      return typeof serialized === "string" && addBytes(encoder.encode(serialized).byteLength);
    };
    while (stack.length) {
      const entry = stack.pop();
      const current = entry.value;
      if (entry.depth > limits.maxDepth) return null;
      nodes += 1;
      if (nodes > limits.maxNodes) return null;
      if (typeof current === "string") {
        if (current.length > limits.maxStringLength || !addJsonPrimitive(current)) return null;
        continue;
      }
      if (current === null) {
        if (!addBytes(4)) return null;
        continue;
      }
      if (typeof current === "boolean") {
        if (!addBytes(current ? 4 : 5)) return null;
        continue;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current) || !addJsonPrimitive(current)) return null;
        continue;
      }
      if (typeof current !== "object") return null;
      if (visited.has(current)) return null;
      visited.add(current);
      if (Array.isArray(current)) {
        if (current.length > limits.maxArrayLength
          || nodes + stack.length + current.length > limits.maxNodes
          || !addBytes(2 + Math.max(0, current.length - 1))) return null;
        for (let index = current.length - 1; index >= 0; index -= 1) {
          stack.push({ value: current[index], depth: entry.depth + 1 });
        }
        continue;
      }
      let prototype;
      try {
        prototype = Object.getPrototypeOf(current);
        if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return null;
      } catch (_) {
        return null;
      }
      if (!addBytes(2)) return null;
      const children = [];
      let keyCount = 0;
      try {
        for (const key in current) {
          if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
          keyCount += 1;
          if (keyCount > limits.maxObjectKeys || key.length > limits.maxKeyLength) return null;
          if (keyCount > 1 && !addBytes(1)) return null;
          if (!addJsonPrimitive(key) || !addBytes(1)) return null;
          children.push(current[key]);
          if (nodes + stack.length + children.length > limits.maxNodes) return null;
        }
      } catch (_) {
        return null;
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ value: children[index], depth: entry.depth + 1 });
      }
    }
    return payload;
  }

  function percentLowercase(value) {
    return value.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase());
  }

  function knownSecretVariants(values) {
    const variants = new Set();
    for (const value of values || []) {
      const raw = asText(value);
      if (raw.length < 8 || raw.length > 4096) continue;
      const encoded = encodeURIComponent(raw);
      const encodedTwice = encodeURIComponent(encoded);
      variants.add(raw);
      variants.add(encoded);
      variants.add(percentLowercase(encoded));
      variants.add(encodedTwice);
      variants.add(percentLowercase(encodedTwice));
      variants.add(raw.replace(/&/g, "&amp;").replace(/=/g, "&#x3D;"));
      variants.add(raw.replace(/&/g, "&amp;").replace(/=/g, "&#61;"));
    }
    return Array.from(variants).filter(Boolean).sort((left, right) => right.length - left.length);
  }

  function redactKnownSecrets(value, secrets, seen) {
    const variants = Array.isArray(secrets) && secrets.__xhsSecretVariants === true
      ? secrets
      : knownSecretVariants(secrets);
    if (!Object.prototype.hasOwnProperty.call(variants, "__xhsSecretVariants")) {
      Object.defineProperty(variants, "__xhsSecretVariants", { value: true });
    }
    if (typeof value === "string") {
      let output = value;
      for (const secret of variants) {
        if (output.includes(secret)) output = output.split(secret).join("[敏感信息已移除]");
      }
      return output;
    }
    if (value === null || value === undefined || typeof value !== "object") return value;
    const visited = seen || new WeakSet();
    if (visited.has(value)) return "[circular]";
    visited.add(value);
    if (Array.isArray(value)) return value.map((entry) => redactKnownSecrets(entry, variants, visited));
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = redactKnownSecrets(child, variants, visited);
    }
    return output;
  }

  function safeFileStem(value, fallback) {
    const normalized = asText(value)
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return normalized || fallback || "xhs-export";
  }

  return {
    acceptCaptureId,
    assertSanitizedExport,
    boundedBridgePayload,
    endpointAllowed,
    extractListItems,
    extractItemsFromPayload,
    extractPageInfo,
    extractSelfId,
    firstHttpUrl,
    isExactDetailUrl,
    mergeItems,
    modeFromEndpoint,
    normalizeItem,
    noteUrl,
    knownSecretVariants,
    redactKnownSecrets,
    redactSecrets,
    sanitizeFreeText,
    safeFileStem,
    stripSensitiveUrl,
    detectMode,
    validNoteId
  };
});
