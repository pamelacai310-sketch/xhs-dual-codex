(function installXhsDualCaptureBridge() {
  "use strict";

  const INSTALL_KEY = "__XHS_DUAL_CODEX_CAPTURE_V1__";
  const CHANNEL = "xhs-dual-codex-v1";
  const ALLOWED_PATHS = [
    /\/api\/sns\/web\/v\d+\/note\/(?:like|likes)\/page(?:\?|$)/i,
    /\/api\/sns\/web\/v\d+\/note\/(?:collect|collection|favorite|favorites)\/page(?:\?|$)/i,
    /\/api\/sns\/web\/v\d+\/(?:feed|note\/detail)(?:\?|$)/i,
    /\/api\/sns\/web\/v\d+\/user\/(?:me|selfinfo)(?:\?|$)/i
  ];
  const MAX_CACHE = 20;
  const MAX_SERIALIZED_BYTES = 6 * 1024 * 1024;
  const ALLOWED_API_ORIGINS = new Set([
    "https://www.xiaohongshu.com",
    "https://edith.xiaohongshu.com"
  ]);

  if (window[INSTALL_KEY]) return;
  Object.defineProperty(window, INSTALL_KEY, { value: true, configurable: false });

  let activeRunId = "";
  const recent = [];

  function normalizedEndpoint(input) {
    try {
      let raw = "";
      if (typeof input === "string") raw = input;
      else if (input instanceof URL) raw = input.href;
      else if (input && typeof input.url === "string") raw = input.url;
      const url = new URL(raw, location.href);
      if (!ALLOWED_API_ORIGINS.has(url.origin)) return "";
      return `${url.pathname}${url.search}`;
    } catch (_) {
      return "";
    }
  }

  function endpointAllowed(endpoint) {
    return endpoint === "initial-state" || ALLOWED_PATHS.some((pattern) => pattern.test(endpoint));
  }

  function nestedValue(root, path) {
    let current = root;
    for (const key of path) {
      if (!current || typeof current !== "object") return undefined;
      current = current[key];
    }
    return current;
  }

  function projectedPayload(endpoint, payload) {
    if (!/\/api\/sns\/web\/v\d+\/user\/(?:me|selfinfo)(?:\?|$)/i.test(endpoint)) return payload;
    const candidates = [
      payload && payload.data,
      payload && payload.user,
      payload && payload.current_user,
      payload && payload.currentUser,
      nestedValue(payload, ["data", "user"]),
      nestedValue(payload, ["data", "user_info"]),
      nestedValue(payload, ["data", "userInfo"]),
      nestedValue(payload, ["user", "currentUser"]),
      nestedValue(payload, ["user", "userInfo"]),
      nestedValue(payload, ["user", "loggedInUser"])
    ];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const value = typeof candidate.user_id === "string" ? candidate.user_id : candidate.userId;
      if (typeof value === "string" && /^[0-9a-zA-Z_-]{12,64}$/.test(value)) {
        return { data: { user_id: value } };
      }
    }
    return null;
  }

  function boundedPayload(payload) {
    try {
      const serialized = JSON.stringify(payload);
      if (serialized.length <= MAX_SERIALIZED_BYTES) return payload;
      if (payload && typeof payload === "object" && payload.data !== undefined) {
        const dataSerialized = JSON.stringify({ data: payload.data });
        if (dataSerialized.length <= MAX_SERIALIZED_BYTES) return { data: payload.data };
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  function emit(record, runId) {
    const payload = boundedPayload(record.payload);
    if (payload === null) return;
    window.postMessage({
      channel: CHANNEL,
      kind: "CAPTURE_DATA",
      captureId: record.captureId,
      runId: runId || activeRunId,
      endpoint: record.endpoint,
      transport: record.transport,
      httpStatus: record.httpStatus,
      payload,
      capturedAt: record.capturedAt
    }, location.origin);
  }

  function remember(endpoint, transport, payload, httpStatus) {
    if (!endpointAllowed(endpoint)) return;
    const projected = projectedPayload(endpoint, payload);
    if (projected === null) return;
    const bounded = boundedPayload(projected);
    if (bounded === null) return;
    const record = {
      captureId: crypto.randomUUID(),
      endpoint,
      transport,
      httpStatus: Number.isInteger(httpStatus) && httpStatus >= 0 && httpStatus <= 599 ? httpStatus : 0,
      payload: bounded,
      capturedAt: new Date().toISOString()
    };
    recent.push(record);
    if (recent.length > MAX_CACHE) recent.shift();
    if (activeRunId) emit(record, activeRunId);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.kind !== "CONTROL") return;
    if (data.action === "START" && typeof data.runId === "string" && /^[a-f0-9-]{20,80}$/i.test(data.runId)) {
      activeRunId = data.runId;
      for (const record of recent) emit(record, activeRunId);
    } else if (data.action === "STOP" && data.runId === activeRunId) {
      activeRunId = "";
    }
  });

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function xhsDualFetch(...args) {
      const endpoint = normalizedEndpoint(args[0]);
      const result = Reflect.apply(originalFetch, this, args);
      if (endpointAllowed(endpoint)) {
        Promise.resolve(result).then((response) => {
          try {
            response.clone().json().then((payload) => {
              remember(endpoint, "fetch", payload, response.status);
            }).catch(() => {});
          } catch (_) {
            // Capturing must never alter the page's request behavior.
          }
        }).catch(() => {});
      }
      return result;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function xhsDualOpen(method, url, ...rest) {
    try {
      this.__xhsDualEndpoint = normalizedEndpoint(url);
    } catch (_) {
      this.__xhsDualEndpoint = "";
    }
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function xhsDualSend(...args) {
    const endpoint = this.__xhsDualEndpoint;
    if (endpointAllowed(endpoint)) {
      this.addEventListener("load", function captureXhsDualResponse() {
        try {
          let payload = null;
          if (this.responseType === "json") payload = this.response;
          else if (this.responseType === "" || this.responseType === "text") payload = JSON.parse(this.responseText);
          if (payload !== null) remember(endpoint, "xhr", payload, this.status);
        } catch (_) {
          // Ignore malformed or non-JSON responses.
        }
      }, { once: true });
    }
    return Reflect.apply(originalSend, this, args);
  };

  function publishInitialState() {
    const candidates = [window.__INITIAL_STATE__, window.__INITIAL_SSR_STATE__, window.__NEXT_DATA__];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object") {
        remember("initial-state", "ssr", candidate, 0);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", publishInitialState, { once: true });
  } else {
    publishInitialState();
  }
  window.setTimeout(publishInitialState, 1500);
})();
