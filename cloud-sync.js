(function attachCloudSync(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CloudSync = factory();
  }
})(typeof window !== "undefined" ? window : globalThis, function createCloudSyncModule() {
  const DEFAULT_TIMEOUT_MS = 8000;
  const DEFAULT_READ_DELAYS_MS = [0, 1000, 3000];
  const DEFAULT_WRITE_DELAYS_MS = [0, 1000, 3000];

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function makeCloudError(message, details = {}) {
    const error = new Error(message);
    Object.assign(error, details);
    return error;
  }

  function isTransientApplicationError(error) {
    return Boolean(error?.applicationError && /timed out|timeout|temporarily unavailable|internal server error|server error/i.test(String(error.message || error)));
  }

  function resolveEndpoint({ runtimeConfig, appConfig } = {}) {
    const environment = runtimeConfig?.environment || appConfig?.ENVIRONMENT || "";
    if (environment === "demo") {
      if (appConfig?.DEMO_MODE !== true || appConfig?.API_BASE_URL !== "/demo-api") {
        throw new Error("Demo mode requires its fixed same-origin /demo-api endpoint.");
      }
      return "/demo-api";
    }
    if (appConfig?.DEMO_MODE === true) {
      throw new Error("Demo mode requires the explicit demo environment.");
    }
    if (!["development", "test", "production"].includes(environment)) {
      throw new Error("Cloud endpoint requires an explicit development, test, production, or demo environment.");
    }
    const directEndpoint = appConfig?.SCRIPT_URL || "";
    const endpoint = appConfig?.ENVIRONMENT === "production"
      ? directEndpoint || runtimeConfig?.endpoint || appConfig?.API_BASE_URL || ""
      : runtimeConfig?.endpoint || directEndpoint || appConfig?.API_BASE_URL || "";
    if (!endpoint || String(endpoint).startsWith("PASTE_")) {
      throw new Error("Cloud endpoint is not configured for the active environment.");
    }
    if (String(endpoint).startsWith("/")) return String(endpoint);
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error("Cloud endpoint is not a valid HTTP or HTTPS URL.");
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("Cloud endpoint must use HTTP or HTTPS.");
    }
    return parsed.href;
  }

  function isTransientError(error) {
    if (!error) return false;
    const status = Number(error.status) || 0;
    if (status >= 400 && status <= 499) return false;
    if (error.applicationError === true && !isTransientApplicationError(error)) return false;
    if (isTransientApplicationError(error)) return true;
    if (error.transient === true || error.code === "TIMEOUT") return true;
    if (error.status >= 500 && error.status <= 599) return true;
    return /failed to fetch|networkerror|network request failed|network down|network|timed out|timeout/i.test(String(error.message || error));
  }

  function classifyCloudError(error) {
    const status = Number(error && error.status) || 0;
    const code = String(error && error.code || "").toUpperCase();
    const message = String(error && error.message || error || "");
    if (status >= 400 && status <= 499) {
      return { kind: "request", retryable: false, message: "Cloud rejected this request. Check the app configuration or contact support." };
    }
    if (isTransientApplicationError(error)) {
      const timedOut = /timed out|timeout/i.test(message);
      return timedOut
        ? { kind: "timeout", retryable: true, message: "Cloud request timed out. Retrying automatically." }
        : { kind: "server", retryable: true, message: "Cloud service is temporarily unavailable. Retrying automatically." };
    }
    if (error?.applicationError) {
      return { kind: "request", retryable: false, message: "Cloud rejected this request. Check the app configuration or contact support." };
    }
    if (status >= 500 && status <= 599) {
      return { kind: "server", retryable: true, message: "Cloud service is temporarily unavailable. Retrying automatically." };
    }
    if (code === "TIMEOUT" || /timed out|timeout/i.test(message)) {
      return { kind: "timeout", retryable: true, message: "Cloud request timed out. Retrying automatically." };
    }
    if (code === "OFFLINE" || /offline|failed to fetch|networkerror|network request failed|network down|internet connection|connection (?:is )?(?:unavailable|refused|lost)/i.test(message)) {
      return { kind: code === "OFFLINE" ? "offline" : "network", retryable: true, message: "Cloud connection is unavailable. Retrying automatically." };
    }
    if (/endpoint|environment|not configured|invalid http|must use http/i.test(message)) {
      return { kind: "configuration", retryable: false, message: "Cloud endpoint is not configured. Check the app setup." };
    }
    return { kind: "unknown", retryable: false, message: "Cloud sync needs attention. Try Refresh or contact support." };
  }

  async function fetchWithTimeout(input, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch) {
    if (typeof AbortController !== "function") return fetchImpl(input, init);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw makeCloudError("Cloud request timed out. Check the internet connection and try again.", {
          code: "TIMEOUT",
          transient: true
        });
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function createCloudClient({
    getUrl,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    readDelaysMs = DEFAULT_READ_DELAYS_MS,
    writeDelaysMs = DEFAULT_WRITE_DELAYS_MS,
    readMaxAttempts = readDelaysMs.length,
    writeMaxAttempts = writeDelaysMs.length,
    sleep: injectedSleep,
    sleepImpl = injectedSleep || sleep
  } = {}) {
    if (typeof getUrl !== "function") throw new Error("Cloud client requires getUrl().");
    let adminSessionToken = "";

    async function request(method, op, payload, queryParams = {}) {
      const url = getUrl();
      if (!url) throw new Error("Cloud endpoint is not configured for the active environment.");

      const isGet = method === "GET";
      const queryUrl = (() => {
        if (!isGet) return url;
        const params = new URLSearchParams();
        params.set("op", op);
        Object.entries(queryParams || {}).forEach(([key, value]) => {
          if (key !== "op" && key !== "_" && value !== undefined && value !== null) {
            params.set(key, String(value));
          }
        });
        params.set("_", String(Date.now()));
        const separator = url.includes("?") ? (/[?&]$/.test(url) ? "" : "&") : "?";
        return url + separator + params.toString();
      })();
      const init = isGet
        ? { method: "GET" }
        : {
            method: "POST",
            // Apps Script Web Apps do not answer the browser's JSON CORS preflight.
            // Keep the body JSON, but use a simple text/plain request so direct POSTs
            // reach doPost without requiring gateway/CORS headers.
            headers: { "Content-Type": "text/plain;charset=utf-8", Accept: "application/json" },
            body: JSON.stringify(payload)
          };

      return fetchWithTimeout(queryUrl, init, timeoutMs, fetchImpl);
    }

    async function parseResponse(res) {
      if (!res.ok) {
        throw makeCloudError("HTTP " + res.status, {
          status: res.status,
          transient: res.status >= 500 && res.status <= 599
        });
      }
      const data = await res.json();
      if (!data.ok) throw makeCloudError(data.error || "Unknown server error", { applicationError: true });
      return data;
    }

    async function get(op, queryParams = {}) {
      let lastError;
      const attempts = Math.max(1, Math.min(readMaxAttempts, readDelaysMs.length || 1));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await sleepImpl(readDelaysMs[attempt] ?? readDelaysMs[readDelaysMs.length - 1] ?? 0);
        try {
          return await parseResponse(await request("GET", op, null, queryParams));
        } catch (error) {
          lastError = error;
          if (!isTransientError(error) || attempt === attempts - 1) throw error;
        }
      }
      throw lastError;
    }

    // A plain POST is deliberately one attempt. Callers must opt into the
    // idempotent write path after the server has durable operation tracking.
    async function post(payload) {
      return parseResponse(await request("POST", "", adminSessionToken
        ? { ...(payload || {}), adminSessionToken }
        : payload));
    }

    async function postWithRetry(payload, { dedupeGuaranteed = false } = {}) {
      if (!dedupeGuaranteed) {
        throw new Error("postWithRetry requires durable server dedupe via dedupeGuaranteed.");
      }
      let lastError;
      const attempts = Math.max(1, Math.min(writeMaxAttempts, writeDelaysMs.length || 1));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await sleepImpl(writeDelaysMs[attempt] ?? writeDelaysMs[writeDelaysMs.length - 1] ?? 0);
        try {
          return await post(payload);
        } catch (error) {
          lastError = error;
          if (!isTransientError(error) || attempt === attempts - 1) throw error;
        }
      }
      throw lastError;
    }

    return {
      get,
      post,
      postWithRetry,
      setAdminSessionToken(token) { adminSessionToken = String(token || ""); },
      clearAdminSessionToken() { adminSessionToken = ""; }
    };
  }

  function createGatewaySessionClient({ getUrl, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof getUrl !== "function") throw new Error("Gateway session client requires getUrl().");
    function sessionUrl() {
      const endpoint = String(getUrl() || "");
      if (!endpoint) throw new Error("Gateway endpoint is not configured.");
      return endpoint.replace(/\/$/, "") + "/admin/session";
    }
    async function login(password) {
      const response = await fetchWithTimeout(sessionUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ password: String(password ?? "") })
      }, timeoutMs, fetchImpl);
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok || !data?.ok) {
        const error = makeCloudError(data?.error?.message || "Administrator authentication failed.", {
          code: data?.error?.code || "AUTH_ADMIN_FAILED",
          status: response.status,
          applicationError: true
        });
        throw error;
      }
      return data;
    }
    return { login };
  }

  return {
    DEFAULT_TIMEOUT_MS,
    DEFAULT_READ_DELAYS_MS,
    DEFAULT_WRITE_DELAYS_MS,
    fetchWithTimeout,
    isTransientError,
    classifyCloudError,
    resolveEndpoint,
    createCloudClient,
    createGatewaySessionClient
  };
});
